/**
 * How well a skill player's next three seasons can be told from one week
 * of this one, against the two readers anybody would reach for first.
 *
 * Standing at week W of season t, every reader says his points a game
 * when he plays and his games out of seventeen in each of t+1, t+2 and
 * t+3, and is marked on the season total those two make, in the board's
 * scoring. Every fit is taught only on seasons that had finished by that
 * week: a t+1 fit at 2023 is taught on 2021 into 2022 and earlier.
 *
 * The readers:
 *  - carried forward: this season's points a game and his share of his
 *    club's games, as they are, every season ahead
 *  - aged: the same, times what players of his age and position kept of
 *    each a horizon on, fitted on the same seasons the model is
 *  - the model, `src/model/seasonsAhead.ts`
 *
 * Marked on the players a keeper league is choosing between, picked at
 * the cut so no reader is marked on a set chosen by what happened: see
 * `isRelevant`. Standard errors resample players, so a man who is in all
 * three seasons goes in or out as one.
 *
 * `--taught` asks whether the stars' shortfall three seasons out is the
 * bench's doing, since its t+3 fits are taught on two or three seasons
 * and the build's on seven: it marks each cut again with every other
 * season taught, the future ones included. That is a diagnostic, not a
 * held out score.
 *
 * Run: npx tsx scripts/seasonsAheadEval.ts [--week 10] [--scoring half] [--ablate] [--taught]
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fitGbm, predictGbm, type GbmModel } from "../src/backtest/gbm.js";
import { spearman } from "../src/backtest/metrics.js";
import {
  HORIZONS, readSeasons, rowsAt, type AheadRow,
} from "../src/features/aheadRows.js";
import {
  aheadTerms, AHEAD_TERMS, ageCurved, carriedForward, fitAgeCurve, fitAhead,
  isRelevant, ppgOf, predictAhead, SHIPPED_TERMS,
  type AheadOptions, type AheadTerm, type SeasonAhead,
} from "../src/model/seasonsAhead.js";
import { scoringRules, type ScoringFormat } from "../src/scoring/fantasyPoints.js";

function argOf(flag: string, fallback: string): string {
  const at = process.argv.indexOf(flag);

  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

const WEEK = Number(argOf("--week", "10"));
const FORMAT = argOf("--scoring", "half") as ScoringFormat;
const ABLATE = process.argv.includes("--ablate");
const TAUGHT = process.argv.includes("--taught");

const FIRST_READ = 2015;
const FIRST_ROW = 2016;
const LAST_READ = 2026;

/** the seasons each horizon is marked on, all of them finished */
const HELD_OUT: Record<number, number[]> = {
  1: [2022, 2023, 2024],
  2: [2022, 2023],
  3: [2021, 2022],
};

/**
 * The seasons the terms were chosen on, left one out at a time, and none
 * of whose outcomes reach a held out season's.
 */
const DEVELOPMENT_THROUGH: Record<number, number> = { 1: 2021, 2: 2020, 3: 2019 };

const BOOTSTRAPS = 400;

interface Marked {
  row: AheadRow;
  actual: number;
  said: Record<string, number>;
  /** the model's rate and games, apart */
  ahead?: SeasonAhead;
}

const total = (s: SeasonAhead | undefined) => (s ? s.ppg * s.games : 0);

/** a seeded draw, so a run repeats */
function rngFrom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const meanOf = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

const mae = (rows: Marked[], reader: string) =>
  meanOf(rows.map((m) => Math.abs(m.said[reader]! - m.actual)));

/**
 * The spread of a statistic over players drawn again with replacement,
 * every season a player is in going with him.
 */
function bootSe(rows: Marked[], stat: (rows: Marked[]) => number): number {
  const byPlayer = new Map<string, Marked[]>();

  for (const m of rows) {
    byPlayer.set(m.row.playerId, [...(byPlayer.get(m.row.playerId) ?? []), m]);
  }

  const players = [...byPlayer.values()];
  const draw = rngFrom(17);
  const stats: number[] = [];

  for (let b = 0; b < BOOTSTRAPS; b++) {
    const sample: Marked[] = [];

    for (let i = 0; i < players.length; i++) {
      sample.push(...players[Math.floor(draw() * players.length)]!);
    }

    stats.push(stat(sample));
  }

  const centre = meanOf(stats);

  return Math.sqrt(meanOf(stats.map((s) => (s - centre) ** 2)));
}

const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);
const f3 = (n: number) => n.toFixed(3).replace(/^0\./, ".").replace(/^-0\./, "-.");
const signed = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1);

const READERS = ["carried", "aged", "model"] as const;

/**
 * Boosted trees on the shipped terms, one pair per position, to ask
 * whether the ridge is leaving a bend in age or capital on the table.
 * The settings are the season model's.
 */
const TREES = { trees: 200, depth: 3, rate: 0.05, minLeaf: 40 };

function treeFit(train: AheadRow[], horizon: number) {
  const keep = AHEAD_TERMS.map((term, i) => [term, i] as const)
    .filter(([term]) => SHIPPED_TERMS.includes(term)).map(([, i]) => i);
  const termsOf = (row: AheadRow) => {
    const all = aheadTerms(row);

    return keep.map((i) => all[i]!);
  };
  const byPosition = new Map<string, { ppg: GbmModel; games: GbmModel }>();

  for (const position of ["QB", "RB", "WR", "TE"]) {
    const mine = train.filter((row) => row.position === position);
    const played = mine.filter((row) => row.ahead[horizon - 1]!.games >= 1);

    byPosition.set(position, {
      ppg: fitGbm(played.map(termsOf), played.map((row) =>
        row.ahead[horizon - 1]!.points / row.ahead[horizon - 1]!.games), TREES),
      games: fitGbm(mine.map(termsOf), mine.map((row) => row.ahead[horizon - 1]!.games), TREES),
    });
  }

  return (row: AheadRow): SeasonAhead | undefined => {
    const his = byPosition.get(row.position);

    return his
      ? {
          ppg: Math.max(0, predictGbm(his.ppg, termsOf(row))),
          games: Math.min(17, Math.max(0, predictGbm(his.games, termsOf(row)))),
        }
      : undefined;
  };
}

/** each reader's word on one row at one horizon, the model under `options` */
function marksFor(
  train: AheadRow[], test: AheadRow[], horizon: number, options: AheadOptions = {},
  extra: Record<string, AheadOptions> = {}, trees = false,
): Marked[] {
  const fit = fitAhead(train, horizon, options);
  const curve = fitAgeCurve(train, horizon);
  const extras = Object.entries(extra)
    .map(([name, opts]) => [name, fitAhead(train, horizon, opts)] as const);
  const grown = trees ? treeFit(train, horizon) : undefined;

  return test.map((row) => {
    const model = predictAhead(fit, row);
    const tree = grown?.(row);

    return {
      row,
      actual: row.ahead[horizon - 1]!.points,
      ahead: model,
      said: {
        carried: total(carriedForward(row)),
        aged: total(ageCurved(curve, row)),
        model: total(model),
        ...Object.fromEntries(extras.map(([name, f]) => [name, total(predictAhead(f, row))])),
        ...(grown
          ? {
              trees: total(tree),
              "ridge and trees": model && tree
                ? total({ ppg: (model.ppg + tree.ppg) / 2, games: (model.games + tree.games) / 2 })
                : 0,
            }
          : {}),
      },
    };
  });
}

const finishedRows = (rows: AheadRow[], horizon: number) =>
  rows.filter((row) => row.ahead[horizon - 1] !== undefined);

/** honest at a cut: taught on rows whose season that far on was over by then */
function heldOut(
  rowsBySeason: Map<number, AheadRow[]>, horizon: number,
  options: AheadOptions = {}, extra: Record<string, AheadOptions> = {}, trees = false,
): Marked[] {
  const marked: Marked[] = [];

  for (const season of HELD_OUT[horizon]!) {
    const train = [...rowsBySeason]
      .filter(([s]) => s <= season - 1 - horizon)
      .flatMap(([, rows]) => finishedRows(rows, horizon));
    const test = finishedRows(rowsBySeason.get(season) ?? [], horizon).filter(isRelevant);

    marked.push(...marksFor(train, test, horizon, options, extra, trees));
  }

  return marked;
}

function printSummary(marked: Marked[], horizon: number, readers: readonly string[]): void {
  console.log(
    `\nseason t+${horizon}, marked on ${HELD_OUT[horizon]!.map((s) => `${s} into ${s + horizon}`).join(", ")}: ${marked.length} player seasons`,
  );
  console.log("| reader | error | se | against aged | se | rmse | ordering | bias |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const reader of readers) {
    const error = mae(marked, reader);
    const gap = error - mae(marked, "aged");
    const rmse = Math.sqrt(meanOf(marked.map((m) => (m.said[reader]! - m.actual) ** 2)));

    console.log(
      `| ${reader} | ${f1(error)} | ${f1(bootSe(marked, (r) => mae(r, reader)))} | ` +
        `${reader === "aged" ? "" : signed(gap)} | ` +
        `${reader === "aged" ? "" : f1(bootSe(marked, (r) => mae(r, reader) - mae(r, "aged")))} | ` +
        `${f1(rmse)} | ${f3(spearman(marked.map((m) => m.said[reader]!), marked.map((m) => m.actual)))} | ` +
        `${signed(meanOf(marked.map((m) => m.said[reader]! - m.actual)))} |`,
    );
  }
}

const BREAKOUTS: [string, (row: AheadRow) => boolean][] = [
  ["rookies", (row) => row.experience === 0],
  ["23 and under", (row) => (row.age ?? 26) < 24],
  ["24 to 26", (row) => (row.age ?? 26) >= 24 && (row.age ?? 26) < 27],
  ["27 to 29", (row) => (row.age ?? 26) >= 27 && (row.age ?? 26) < 30],
  ["30 and over", (row) => (row.age ?? 26) >= 30],
  ["first round rookie backs and receivers", (row) =>
    row.experience === 0 && row.drafted?.round === 1 &&
    (row.position === "RB" || row.position === "WR")],
  ["fourteen a game or more so far", (row) => row.games >= 2 && ppgOf(row) >= 14],
];

function printBreakouts(marked: Marked[], horizon: number): void {
  console.log(`\nseason t+${horizon} by who, error and bias in season points`);
  console.log("| who | players | carried | aged | model | model against aged |");
  console.log("| --- | --- | --- | --- | --- | --- |");

  for (const [who, pick] of BREAKOUTS) {
    const mine = marked.filter((m) => pick(m.row));

    if (mine.length === 0) {
      continue;
    }

    const cell = (reader: string) =>
      `${f1(mae(mine, reader))} (${signed(meanOf(mine.map((m) => m.said[reader]! - m.actual)))})`;
    const gap = mae(mine, "model") - mae(mine, "aged");

    console.log(
      `| ${who} | ${mine.length} | ${cell("carried")} | ${cell("aged")} | ${cell("model")} | ` +
        `${signed(gap)} ± ${f1(bootSe(mine, (r) => mae(r, "model") - mae(r, "aged")))} |`,
    );
  }
}

/* ---------- which terms earned their place ---------- */

const without = (...out: AheadTerm[]): AheadOptions => ({
  terms: SHIPPED_TERMS.filter((term) => !out.includes(term)),
});
const adding = (...more: AheadTerm[]): AheadOptions => ({
  terms: [...SHIPPED_TERMS, ...more],
});

const VARIANTS: Record<string, AheadOptions> = {
  "without this season and last together":
    without("points a game, this season and last", "the same, squared"),
  "without the square of it": without("the same, squared"),
  "without last season": without("points a game last season", "games last season"),
  "without age": without("age", "age, squared about 26"),
  "without seasons in the league": without("seasons in the league", "rookie"),
  "without draft capital": without("draft capital, first three seasons", "undrafted"),
  "without snap share and work share": without("snap share", "share of the work at his position"),
  "with the trends in his snaps and share": adding("snap trend", "work share trend"),
  "with where he stands on the roster":
    adding("on a reserve list", "on a practice squad", "off his club's roster"),
  "with the room he plays in": adding("busiest teammate's share", "young high pick in his room"),
  "with the season before last":
    adding("points a game the season before last", "games the season before last"),
  "with draft capital in every season": adding("draft capital, every season", "first round pick"),
  "a penalty of 3 rather than 10": { lambda: 3 },
  "a penalty of 30": { lambda: 30 },
  "a penalty of 100": { lambda: 100 },
};

/**
 * Each season of the development years marked by a fit taught on the
 * others, which is how the terms were chosen. None of these outcomes is
 * an outcome the held out seasons are marked on.
 */
function development(
  rowsBySeason: Map<number, AheadRow[]>, horizon: number,
): Marked[] {
  const through = DEVELOPMENT_THROUGH[horizon]!;
  const marked: Marked[] = [];
  const extra = VARIANTS;

  for (let season = FIRST_ROW; season <= through; season++) {
    const train = [...rowsBySeason]
      .filter(([s]) => s <= through && s !== season)
      .flatMap(([, rows]) => finishedRows(rows, horizon));
    const test = finishedRows(rowsBySeason.get(season) ?? [], horizon).filter(isRelevant);

    marked.push(...marksFor(train, test, horizon, {}, extra));
  }

  return marked;
}

function printAblation(rowsBySeason: Map<number, AheadRow[]>): void {
  const byHorizon = Array.from({ length: HORIZONS }, (_, k) => development(rowsBySeason, k + 1));

  console.log(
    `\nwhat each term is worth, development seasons ${FIRST_ROW} to ` +
      `${DEVELOPMENT_THROUGH[1]} left out one at a time: error against the shipped fit, ` +
      "plus is worse",
  );
  console.log("| change | t+1 | t+2 | t+3 | rookies, t+1 |");
  console.log("| --- | --- | --- | --- | --- |");

  for (const name of Object.keys(VARIANTS)) {
    const cells = byHorizon.map((marked) => {
      const gap = mae(marked, name) - mae(marked, "model");

      return `${signed(gap)} ± ${f1(bootSe(marked, (r) => mae(r, name) - mae(r, "model")))}`;
    });
    const rookies = byHorizon[0]!.filter((m) => m.row.experience === 0);

    console.log(
      `| ${name} | ${cells.join(" | ")} | ${signed(mae(rookies, name) - mae(rookies, "model"))} |`);
  }

  console.log(
    `\nshipped fit on the development seasons: ${byHorizon.map((m, k) =>
      `t+${k + 1} ${f1(mae(m, "model"))} against aged ${f1(mae(m, "aged"))}`).join(", ")}`);
}

/* ---------- is the stars' shortfall the bench or the model ---------- */

const isStar = BREAKOUTS.find(([who]) => who === "fourteen a game or more so far")![1];

const biasOf = (rows: Marked[], reader = "model") =>
  meanOf(rows.map((m) => m.said[reader]! - m.actual));

/** the cut seasons with an outcome that far on, oldest first */
const seasonsWith = (rowsBySeason: Map<number, AheadRow[]>, horizon: number) =>
  [...rowsBySeason.keys()].sort((a, b) => a - b)
    .filter((s) => (rowsBySeason.get(s) ?? []).some((row) => row.ahead[horizon - 1] !== undefined));

const rowsOf = (rowsBySeason: Map<number, AheadRow[]>, seasons: number[], horizon: number) =>
  seasons.flatMap((s) => finishedRows(rowsBySeason.get(s) ?? [], horizon));

/**
 * Where a group's miss is: the games said against played over all of
 * them, and the rate said against had over the games they did play.
 */
function partsOf(marked: Marked[], horizon: number): string {
  const later = (m: Marked) => m.row.ahead[horizon - 1]!;
  const played = marked.filter((m) => later(m).games >= 1);
  const games = played.reduce((sum, m) => sum + later(m).games, 0);
  const rateSaid = played.reduce((sum, m) => sum + (m.ahead?.ppg ?? 0) * later(m).games, 0) / games;
  const rateHad = played.reduce((sum, m) => sum + later(m).points, 0) / games;

  return `${f1(meanOf(marked.map((m) => m.ahead?.games ?? 0)))} / ${f1(meanOf(marked.map((m) => later(m).games)))} | ` +
    `${f1(rateSaid)} / ${f1(rateHad)}`;
}

const starLine = (label: string, stars: Marked[], horizon: number) =>
  `| ${label} | ${stars.length} | ${signed(biasOf(stars))} | ${f1(bootSe(stars, (r) => biasOf(r)))} | ` +
    `${partsOf(stars, horizon)} |`;

/**
 * Each cut marked twice: by fits taught on the seasons before it, the
 * way the held out seasons are, and by fits taught on every other season
 * with an outcome that far on, the later ones included. The second is
 * not a score anybody could have had on the day; it says only whether
 * the shortfall shrinks once a fit has more seasons to learn from.
 */
function printTaught(rowsBySeason: Map<number, AheadRow[]>): void {
  console.log(
    "\nDIAGNOSTIC, not a held out score: the stars, fourteen a game or more so far, " +
      "marked by fits taught on the seasons before the cut and by fits taught on every other season");

  for (let horizon = 1; horizon <= HORIZONS; horizon++) {
    const seasons = seasonsWith(rowsBySeason, horizon);

    console.log(`\nseason t+${horizon}, star bias in season points (everybody's beside it)`);
    console.log("| cut | the seasons before it, all | the last two | the last three | every other season |");
    console.log("| --- | --- | --- | --- | --- |");

    const pooled = { honest: [] as Marked[], other: [] as Marked[] };

    for (const test of seasons) {
      const before = seasons.filter((s) => s <= test - 1 - horizon);
      const testRows = finishedRows(rowsBySeason.get(test) ?? [], horizon).filter(isRelevant);
      const cell = (taught: number[], keep?: Marked[]) => {
        if (taught.length === 0) {
          return "";
        }

        const train = rowsOf(rowsBySeason, taught, horizon);
        const marked = marksFor(train, testRows, horizon);

        keep?.push(...marked);

        return `${signed(biasOf(marked.filter((m) => isStar(m.row))))} (${signed(biasOf(marked))}), ${taught.length}`;
      };

      console.log(
        `| ${test} | ${cell(before, pooled.honest)} | ` +
          `${before.length > 2 ? cell(before.slice(-2)) : ""} | ` +
          `${before.length > 3 ? cell(before.slice(-3)) : ""} | ` +
          `${cell(seasons.filter((s) => s !== test), pooled.other)} |`);
    }

    const held = HELD_OUT[horizon]!;
    const heldIn = (marked: Marked[]) => marked.filter((m) => held.includes(m.row.season));
    const rows: [string, Marked[]][] = [
      ["the held out cuts, taught on the seasons before them", heldIn(pooled.honest)],
      ["the held out cuts, taught on every other season", heldIn(pooled.other)],
      ["every cut, taught on every other season", pooled.other],
    ];

    console.log("\n| the stars | players | bias | se | games said / played | rate said / had |");
    console.log("| --- | --- | --- | --- | --- | --- |");

    for (const [label, marked] of rows) {
      console.log(starLine(label, marked.filter((m) => isStar(m.row)), horizon));
    }

    for (const position of ["QB", "RB", "WR", "TE"]) {
      const mine = (m: Marked) => isStar(m.row) && m.row.position === position;

      console.log(starLine(
        `${position}, held out cuts taught before them`,
        pooled.honest.filter((m) => mine(m) && held.includes(m.row.season)), horizon));
      console.log(starLine(`${position}, every cut taught on every other`, pooled.other.filter(mine), horizon));
    }
  }
}

/* ---------- the case that started this ---------- */

const LOVE = "00-0041027";

/** the board's own rate for him, if the board on disk has him */
function boardPpg(season: number, name: string): number | undefined {
  const path = join(import.meta.dirname, "..", "docs", "data", `board-${season}.json`);

  if (!existsSync(path)) {
    return undefined;
  }

  const board = JSON.parse(readFileSync(path, "utf8")) as {
    players: { name: string; ppg?: number }[];
  };

  return board.players.find((p) => p.name === name)?.ppg;
}

function printCase(rowsBySeason: Map<number, AheadRow[]>): void {
  const season = Math.max(...rowsBySeason.keys());
  const him = rowsBySeason.get(season)?.find((row) => row.playerId === LOVE);
  const fits = Array.from({ length: HORIZONS }, (_, k) => fitAhead(
    [...rowsBySeason].filter(([s]) => s <= season - 1 - k)
      .flatMap(([, rows]) => finishedRows(rows, k + 1)),
    k + 1,
  ));

  if (!him) {
    console.log(`\nno row for ${LOVE} in ${season}`);
    return;
  }

  const board = boardPpg(season, him.name);
  const say = (label: string, row: AheadRow) => {
    const seasons = fits.map((fit) => predictAhead(fit, row));

    console.log(
      `| ${label} | ${seasons.map((s) => s ? `${f1(s.ppg)} in ${f1(s.games)}` : "-").join(" | ")} |`);
  };

  console.log(
    `\n${him.name}, week ${WEEK} of ${season}: pick ${him.drafted?.overall}, age ${him.age}, ` +
      `${him.games} games of ${him.clubGames} at ${f1(him.points / Math.max(1, him.games))} a game, ` +
      `snap share ${f2(him.snapShare ?? 0)} with a trend of ${f2(him.snapTrend ?? 0)}, ` +
      `${f2(him.share ?? 0)} of the backs' work, ${him.standing}` +
      (board ? `; the board has him at ${board} a game` : ""));
  console.log(`| what changes | ${season + 1} | ${season + 2} | ${season + 3} |`);
  console.log("| --- | --- | --- | --- |");
  say("him", him);
  say("taken 40th", { ...him, drafted: { ...him.drafted!, round: 2, overall: 40 } });
  say("undrafted", { ...him, drafted: null });
  say("23 rather than 21", { ...him, age: (him.age ?? 21) + 2 });
  say("every game his club played, at the same rate", {
    ...him, games: him.clubGames, points: him.points / Math.max(1, him.games) * him.clubGames,
  });

  if (board) {
    const of = fits.map((fit) => predictAhead(fit, him)!.ppg / board);

    console.log(`as the board writes it: of ${of.map(f2).join(", ")} on its ${board}`);
  }

  console.log("\nevery rookie back taken in the top twelve, at the same week, and what came next");
  console.log("| who | season | pick | so far | games | said t+1 | was t+1 | said t+2 | was t+2 |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const [s, rows] of [...rowsBySeason].sort((a, b) => a[0] - b[0])) {
    for (const row of rows) {
      if (row.position !== "RB" || row.experience !== 0 || !row.drafted ||
          row.drafted.overall > 12) {
        continue;
      }

      const cells = [1, 2].flatMap((k) => {
        const train = [...rowsBySeason].filter(([t]) => t <= s - 1 - k)
          .flatMap(([, r]) => finishedRows(r, k));
        const said = train.length ? predictAhead(fitAhead(train, k), row) : undefined;
        const was = row.ahead[k - 1];

        return [
          said ? `${f1(said.ppg)} in ${f1(said.games)}` : "-",
          was ? `${f1(was.games > 0 ? was.points / was.games : 0)} in ${f1(was.games)}` : "-",
        ];
      });

      console.log(
        `| ${row.name} | ${s} | ${row.drafted.overall} | ${f1(row.points / Math.max(1, row.games))} | ` +
          `${row.games} of ${row.clubGames} | ${cells.join(" | ")} |`);
    }
  }
}

async function main(): Promise<void> {
  const { reads, people } = await readSeasons(FIRST_READ, LAST_READ, scoringRules(FORMAT));
  const rowsBySeason = new Map<number, AheadRow[]>();

  for (let season = FIRST_ROW; season <= LAST_READ; season++) {
    rowsBySeason.set(season, rowsAt(season, WEEK, reads, people));
  }

  console.log(
    `cut at week ${WEEK}, ${FORMAT} scoring, ` +
      `${[...rowsBySeason.values()].reduce((n, rows) => n + rows.length, 0)} player seasons read`);

  for (let horizon = 1; horizon <= HORIZONS; horizon++) {
    const marked = heldOut(rowsBySeason, horizon, {}, {}, ABLATE);

    printSummary(marked, horizon, ABLATE ? [...READERS, "trees", "ridge and trees"] : READERS);
    printBreakouts(marked, horizon);
  }

  if (ABLATE) {
    printAblation(rowsBySeason);
  }

  if (TAUGHT) {
    printTaught(rowsBySeason);
  }

  printCase(rowsBySeason);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

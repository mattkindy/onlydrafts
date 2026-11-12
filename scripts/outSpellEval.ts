/**
 * How long a player ruled Out stays out, and what he scores once back.
 *
 * The app took one game off a man listed Out and priced every week after
 * it at the board's healthy rate, his expected games over seventeen. A
 * hamstring or a high ankle is often three weeks, so this counts what
 * really happened in the games after an Out listing, over the regular
 * seasons 2018 to 2025 at QB, RB, WR and TE.
 *
 * A listing counts when the final report for his side's game said Out, he
 * was not on a reserve list that week, and he had a steady role: two or
 * more games played before it and half or more of the snaps over his last
 * three. He counts as having played a game if he has a stat row or an
 * offensive snap, the rule `injuryStatusEval.ts` uses. Each of his side's
 * next games is a yes or a no, censored at the end of the season.
 *
 * Rules for the chance he plays in each of his side's next four games are
 * fitted on 2018 to 2022 and scored by Brier score on 2023 to 2025, against
 * the app's old rule at his board games and against a ceiling of the
 * scoring seasons' own rates. The board games come from the shipped
 * availability model, fitted on the seasons before each one. The app's
 * `playsByWeek` as it ships now is scored beside them, in sample, since
 * its table is counted over every season.
 *
 * Then the games after a short absence, one to three games missed and at
 * least one of them on the report as Out or Doubtful, against players of
 * the same level who were never listed, the way `injuredReserveEval.ts`
 * measured the ramp for reserve.
 *
 * Run: npx tsx scripts/outSpellEval.ts [--seasons 2018-2025]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  gameWeeksFrom, playsByWeek, SEASON_WEEKS,
} from "../app/lib/availability.ts";
import { parseCsv } from "../src/data/csv.js";
import { normalizeName } from "../src/data/names.js";
import {
  canonicalTeam, loadGames, loadPlayerStats, loadSnapCounts,
  loadWeeklyRosters, RAW_DIR, type GameRow,
} from "../src/data/nflverse.js";
import { seasonsAsked } from "../src/data/seasons.js";
import { readAvailability } from "../src/features/availabilityData.js";
import {
  fitAvailability, predictAvailability,
} from "../src/features/gamesPlayed.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const FIT_SEASONS = [2018, 2019, 2020, 2021, 2022];
const SCORE_SEASONS = [2023, 2024, 2025];
/** what an argument says, or the default */
function argOf(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);

  return at === -1 ? fallback : process.argv[at + 1] ?? fallback;
}

/** a share of the snaps over his last three games that makes a role steady */
const STEADY = Number(argOf("--steady", "0.5"));
/** the word on the report whose games after it are counted */
const STATUS = argOf("--status", "Out");
/** his side's games after the listing the return is read over */
const AHEAD = 8;
/** and the ones the rules are scored on */
const SCORED = 4;
/** points a game before an absence that makes him somebody's starter */
const MATTERS = 7;
/** the weeks the never listed control is cut at, as the reserve eval does */
const CONTROL_CUTS = [6, 9, 12];
/** the level bands a returner is matched to the control in */
const BANDS = [7, 10, 14];
/** the roster codes that mean a reserve list rather than a week's word */
const ON_A_LIST = new Set(["RES", "PUP", "SUS", "NWT", "RSN"]);
/** below this many listings a cell falls back to the coarser table */
const THIN = 40;

/** the body parts the report files, gathered where the counts allow */
const PARTS: [string, RegExp][] = [
  ["hamstring", /hamstring/],
  ["ankle", /ankle/],
  ["knee", /knee|acl|mcl|meniscus/],
  ["concussion", /concussion|head/],
  ["foot", /foot|toe|heel/],
];

const partOf = (raw: string) =>
  PARTS.find(([, test]) => test.test(raw.toLowerCase()))?.[0] ?? "other";

interface Report {
  status: string;
  part: string;
  team: string;
  name: string;
  position: string;
}

interface SeasonFiles {
  season: number;
  /** each side's game weeks, earliest first */
  sideWeeks: Map<string, number[]>;
  lastWeek: number;
  /** half PPR points, by `playerId|week`, for every stat row */
  points: Map<string, number>;
  /** the side he had a stat row for, by `playerId|week` */
  sideOf: Map<string, string>;
  /** where the stat rows file him */
  positionOf: Map<string, string>;
  /** everyone the report gave a status at any point of the season */
  everListed: Set<string>;
  /** his share of the snaps, by `name|week` */
  snaps: Map<string, number>;
  /** the last report of his week, by `playerId|week` */
  reports: Map<string, Report>;
  /** the weekly roster code, by `playerId|week` */
  roster: Map<string, string>;
}

async function readSeason(season: number, games: GameRow[]): Promise<SeasonFiles> {
  const sideWeeks = new Map<string, number[]>();
  let lastWeek = 0;

  for (const game of games.filter((g) => g.season === season)) {
    lastWeek = Math.max(lastWeek, game.week);

    for (const side of [game.homeTeamId, game.awayTeamId]) {
      const team = canonicalTeam(side);

      sideWeeks.set(team, [...(sideWeeks.get(team) ?? []), game.week]);
    }
  }

  for (const weeks of sideWeeks.values()) {
    weeks.sort((a, b) => a - b);
  }

  const points = new Map<string, number>();
  const sideOf = new Map<string, string>();
  const positionOf = new Map<string, string>();

  for (const row of await loadPlayerStats(season)) {
    if (row.week > 18) {
      continue;
    }

    points.set(`${row.playerId}|${row.week}`, fantasyPoints(row.statLine, presets.half));
    sideOf.set(`${row.playerId}|${row.week}`, canonicalTeam(row.teamId));
    positionOf.set(row.playerId, row.position);
  }

  const snaps = new Map<string, number>();

  for (const row of await loadSnapCounts(season)) {
    const share = row.offensePct > 1.5 ? row.offensePct / 100 : row.offensePct;
    const key = `${normalizeName(row.playerName)}|${row.week}`;

    snaps.set(key, Math.max(snaps.get(key) ?? 0, share));
  }

  const roster = new Map<string, string>();

  for (const row of await loadWeeklyRosters(season)) {
    if (row.status) {
      roster.set(`${row.playerId}|${row.week}`, row.status);
    }
  }

  const text = await readFile(join(RAW_DIR, `injuries_${season}.csv`), "utf8");
  const reports = new Map<string, Report>();
  const everListed = new Set<string>();

  // a player has a row per report and the last one is the ruling that stood
  for (const row of parseCsv(text)) {
    if (row["game_type"] !== "REG") {
      continue;
    }

    if (row["report_status"]) {
      everListed.add(row["gsis_id"] ?? "");
    }

    if (!POSITIONS.has(row["position"] ?? "")) {
      continue;
    }

    reports.set(`${row["gsis_id"]}|${row["week"]}`, {
      status: row["report_status"] ?? "",
      part: row["report_primary_injury"] ?? "",
      team: canonicalTeam(row["team"] ?? ""),
      name: row["full_name"] ?? "",
      position: row["position"] ?? "",
    });
  }

  return {
    season, sideWeeks, lastWeek, points, sideOf, positionOf, everListed,
    snaps, reports, roster,
  };
}

/** a stat row or a snap, the rule the injury status eval uses */
const playedIn = (files: SeasonFiles, playerId: string, name: string, week: number) =>
  files.points.has(`${playerId}|${week}`) ||
  (files.snaps.get(`${normalizeName(name)}|${week}`) ?? 0) > 0;

/** the week his side has no game, if the season has one */
function byeOf(files: SeasonFiles, team: string): number | undefined {
  const weeks = new Set(files.sideWeeks.get(team) ?? []);

  for (let w = 1; w <= files.lastWeek; w++) {
    if (!weeks.has(w)) {
      return w;
    }
  }

  return undefined;
}

/* ---------- the listings ---------- */

interface Spell {
  season: number;
  week: number;
  playerId: string;
  name: string;
  position: string;
  part: string;
  /** games missed in a row with this one, 3 standing for three or more */
  streak: number;
  /** played in each of his side's next games, as far as the season goes */
  ahead: boolean[];
  /** the app's old chance for each of those games, the board's healthy rate */
  app: number[];
  /** and what `playsByWeek` says for them now */
  now: number[];
  /** the board's games for him, the healthy rate the app prices after one */
  games: number;
}

/**
 * The rule the app had for a man ruled Out, kept here so it can still be
 * marked: the coming game off, and the games the board expects of him
 * over the weeks that are left spread evenly over the rest of them.
 */
function healthyAfterOne(games: number, from: number, bye?: number): number[] {
  const weeks = gameWeeksFrom(from, bye);
  const playing = weeks.length - 1;
  const expected = games * (weeks.length / (SEASON_WEEKS - 1));
  const each = playing > 0 ? Math.min(1, Math.min(expected, playing) / playing) : 0;
  const worth = new Map(weeks.map((w, i) => [w, i === 0 ? 0 : each]));

  return Array.from(
    { length: Math.max(0, SEASON_WEEKS - from + 1) },
    (_, i) => worth.get(from + i) ?? 0,
  );
}

function spellsIn(files: SeasonFiles, boardGames: Map<string, number>): Spell[] {
  const spells: Spell[] = [];
  const fallback = median([...boardGames.values()]);

  for (const [key, report] of files.reports) {
    if (report.status !== STATUS) {
      continue;
    }

    const [playerId = "", weekText = ""] = key.split("|");
    const week = Number(weekText);

    if (ON_A_LIST.has(files.roster.get(key) ?? "")) {
      continue;
    }

    const weeks = files.sideWeeks.get(report.team) ?? [];

    if (!weeks.includes(week)) {
      continue;
    }

    const played = (w: number) => playedIn(files, playerId, report.name, w);
    const before = weeks.filter((w) => w < week);
    const playedBefore = before.filter(played);

    if (playedBefore.length < 2) {
      continue;
    }

    const recent = playedBefore.slice(-3);
    const snaps = recent.reduce((sum, w) =>
      sum + (files.snaps.get(`${normalizeName(report.name)}|${w}`) ?? 0), 0) /
      recent.length;

    if (snaps < STEADY) {
      continue;
    }

    let missed = 0;

    for (let i = before.length - 1; i >= 0 && !played(before[i]!); i--) {
      missed++;
    }

    const next = weeks.filter((w) => w > week).slice(0, AHEAD);
    const games = boardGames.get(playerId) ?? fallback;
    const bye = byeOf(files, report.team);
    const app = healthyAfterOne(games, week, bye);
    const now = playsByWeek(games, "Out", week, bye);

    spells.push({
      season: files.season,
      week,
      playerId,
      name: report.name,
      position: report.position,
      part: partOf(report.part),
      streak: Math.min(3, missed + 1),
      ahead: next.map(played),
      app: next.map((w) => app[w - week] ?? 0),
      now: next.map((w) => now[w - week] ?? 0),
      games,
    });
  }

  return spells;
}

/* ---------- the returns ---------- */

interface Return {
  season: number;
  /** his side's games missed in a row */
  missed: number;
  ppg: number;
  /** his points in each game he played from the return on */
  after: number[];
}

interface Control {
  season: number;
  ppg: number;
  after: number[];
}

/**
 * Every short absence of a player who matters: one to three of his side's
 * games missed in a row after two or more played, at least one of them
 * on the report as Out or Doubtful, never on a reserve list, and a game
 * played after it. Beside it, the players at the same level his season
 * never put on the report at all.
 */
function returnsIn(files: SeasonFiles): { returns: Return[]; control: Control[] } {
  const returns: Return[] = [];
  const control: Control[] = [];
  const byPlayer = new Map<string, number[]>();

  for (const key of files.points.keys()) {
    const [playerId = "", week = ""] = key.split("|");

    byPlayer.set(playerId, [...(byPlayer.get(playerId) ?? []), Number(week)]);
  }

  for (const [playerId, scoredWeeks] of byPlayer) {
    scoredWeeks.sort((a, b) => a - b);

    const reportOf = (w: number) => files.reports.get(`${playerId}|${w}`);
    const listed = (w: number) =>
      ["Out", "Doubtful"].includes(reportOf(w)?.status ?? "");
    const onList = (w: number) =>
      ON_A_LIST.has(files.roster.get(`${playerId}|${w}`) ?? "");
    const pointsAt = (w: number) => files.points.get(`${playerId}|${w}`)!;

    if (!POSITIONS.has(files.positionOf.get(playerId) ?? "")) {
      continue;
    }

    const everOnList = Array.from({ length: files.lastWeek }, (_, w) => w + 1)
      .some(onList);

    if (!files.everListed.has(playerId) && !everOnList) {
      const team = files.sideOf.get(`${playerId}|${scoredWeeks[0]}`) ?? "";
      const weeks = files.sideWeeks.get(team) ?? [];

      for (const cut of CONTROL_CUTS) {
        const had = scoredWeeks.filter((w) => w < cut).map(pointsAt);
        const ppg = mean(had);

        if (had.length >= 2 && ppg >= MATTERS && weeks.includes(cut)) {
          control.push({
            season: files.season,
            ppg,
            after: scoredWeeks.filter((w) => w >= cut).slice(0, 4).map(pointsAt),
          });
        }
      }

      continue;
    }

    for (let i = 1; i < scoredWeeks.length - 1; i++) {
      const last = scoredWeeks[i]!;
      const back = scoredWeeks[i + 1]!;
      const team = files.sideOf.get(`${playerId}|${last}`) ?? "";
      const weeks = files.sideWeeks.get(team) ?? [];
      const gap = weeks.filter((w) => w > last && w < back);

      if (gap.length < 1 || gap.length > 3) {
        continue;
      }

      if (!gap.some(listed) || gap.some(onList)) {
        continue;
      }

      const had = scoredWeeks.slice(0, i + 1).map(pointsAt);
      const ppg = mean(had);

      if (had.length < 2 || ppg < MATTERS) {
        continue;
      }

      returns.push({
        season: files.season,
        missed: gap.length,
        ppg,
        after: scoredWeeks.slice(i + 1, i + 5).map(pointsAt),
      });
    }
  }

  return { returns, control };
}

/* ---------- arithmetic ---------- */

const mean = (xs: number[]) =>
  xs.reduce((sum, x) => sum + x, 0) / Math.max(1, xs.length);

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)] ?? 13;
}

const bandOf = (ppg: number) =>
  BANDS.filter((low) => ppg >= low).length - 1;

/* ---------- the rules ---------- */

/** a rule's chance he plays his side's kth game after the listing, k from 0 */
type Rule = (spell: Spell, k: number) => number;

/** the share of a group that played its kth game after the listing */
function rateAt(spells: Spell[], k: number): { rate: number; n: number } {
  const had = spells.filter((s) => s.ahead.length > k);

  return {
    rate: mean(had.map((s) => Number(s.ahead[k]))),
    n: had.length,
  };
}

/**
 * A table of rates by the games ahead and whatever `cellOf` says, with a
 * thin cell handing over to `coarser`.
 */
function tableRule(
  fit: Spell[], cellOf: (s: Spell) => string, coarser?: Rule,
): Rule {
  const rates = new Map<string, number>();
  const cells = new Set(fit.map(cellOf));

  for (const cell of cells) {
    const group = fit.filter((s) => cellOf(s) === cell);

    for (let k = 0; k < SCORED; k++) {
      const { rate, n } = rateAt(group, k);

      if (n >= THIN || !coarser) {
        rates.set(`${cell}|${k}`, rate);
      }
    }
  }

  return (spell, k) =>
    rates.get(`${cellOf(spell)}|${k}`) ?? coarser?.(spell, k) ?? 1;
}

function brier(spells: Spell[], rule: Rule, ks = [0, 1, 2, 3]): number {
  let total = 0;
  let n = 0;

  for (const spell of spells) {
    for (const k of ks) {
      if (spell.ahead.length <= k) {
        continue;
      }

      total += (rule(spell, k) - Number(spell.ahead[k])) ** 2;
      n++;
    }
  }

  return total / Math.max(1, n);
}

/* ---------- printing ---------- */

const fixed = (n: number, places = 2) => n.toFixed(places);

function returnTable(title: string, spells: Spell[], groupOf: (s: Spell) => string, order: string[]) {
  console.log(`\n## ${title}\n`);
  console.log(
    "| | listings | " +
      Array.from({ length: AHEAD }, (_, k) => `${k + 1}`).join(" | ") +
      " | app before, next |",
  );
  console.log("|" + " --- |".repeat(AHEAD + 3));

  for (const group of order) {
    const some = spells.filter((s) => groupOf(s) === group);

    if (!some.length) {
      continue;
    }

    const cells = Array.from({ length: AHEAD }, (_, k) => {
      const { rate, n } = rateAt(some, k);

      return n >= 15 ? fixed(rate) : "";
    });

    console.log(
      `| ${group} | ${some.length} | ${cells.join(" | ")} | ` +
        `${fixed(mean(some.flatMap((s) => s.app.slice(0, 1))))} |`,
    );
  }
}

const STREAK_WORDS = ["", "first game out", "second in a row", "third or more"];

function describe(spells: Spell[]) {
  console.log(
    `${spells.length} ${STATUS} listings at ${STEADY} of the snaps or more, ` +
      `${new Set(spells.map((s) => `${s.season}|${s.playerId}`)).size} player seasons`,
  );

  returnTable(
    "Played his side's kth game after the listing, by games missed in a row",
    spells, (s) => STREAK_WORDS[s.streak]!, STREAK_WORDS.slice(1),
  );
  returnTable(
    "The first game out only, by what the report says is hurt",
    spells.filter((s) => s.streak === 1), (s) => s.part,
    [...PARTS.map(([name]) => name), "other"],
  );
  returnTable(
    "The first game out only, by position",
    spells.filter((s) => s.streak === 1), (s) => s.position,
    ["QB", "RB", "WR", "TE"],
  );
  returnTable(
    "Everyone, by position",
    spells, (s) => s.position, ["QB", "RB", "WR", "TE"],
  );
}

/**
 * The same table read as a share of the app's own rate, so a man the board
 * expects to play more often keeps more of each game than one it expects
 * to play less.
 */
function relativeRule(
  fit: Spell[], cellOf: (s: Spell) => string, coarser?: Rule,
): Rule {
  const factors = new Map<string, number>();

  for (const cell of new Set(fit.map(cellOf))) {
    const group = fit.filter((s) => cellOf(s) === cell);

    for (let k = 0; k < SCORED; k++) {
      const had = group.filter((s) => s.ahead.length > k);

      if (had.length >= THIN || !coarser) {
        factors.set(`${cell}|${k}`,
          mean(had.map((s) => Number(s.ahead[k]))) / mean(had.map((s) => s.app[k]!)));
      }
    }
  }

  return (spell, k) => {
    const factor = factors.get(`${cellOf(spell)}|${k}`);

    return factor === undefined
      ? coarser?.(spell, k) ?? spell.app[k]!
      : Math.min(1, factor * spell.app[k]!);
  };
}

type Builder = (fit: Spell[]) => Rule;

const overall: Builder = (fit) => tableRule(fit, () => "all");

const BUILDERS: [string, Builder][] = [
  ["A  the app before, his healthy rate after one", () => (s, k) => s.app[k]!],
  ["B  measured by games ahead", overall],
  ["C  by games ahead and games missed in a row",
    (fit) => tableRule(fit, (s) => String(s.streak), overall(fit))],
  ["D  B, and the body part",
    (fit) => tableRule(fit, (s) => s.part, overall(fit))],
  ["E  C, and the body part",
    (fit) => tableRule(fit, (s) => `${s.streak}|${s.part}`,
      tableRule(fit, (s) => String(s.streak), overall(fit)))],
  ["F  B, and the position",
    (fit) => tableRule(fit, (s) => s.position, overall(fit))],
  ["G  B as a share of the app's own rate", (fit) => relativeRule(fit, () => "all")],
  ["H  G, and the body part",
    (fit) => relativeRule(fit, (s) => s.part, relativeRule(fit, () => "all"))],
  // what ships: a man is never likelier to play for having been hurt
  ["I  B, never above the app's own rate",
    (fit) => {
      const byAhead = overall(fit);

      return (s, k) => Math.min(byAhead(s, k), s.app[k]!);
    }],
];

/**
 * Each rule fitted on four of the fit seasons and scored on the fifth, in
 * turn, so a rule can be chosen without looking at the scored seasons.
 */
function heldOut(fit: Spell[], build: Builder): number {
  return mean(FIT_SEASONS.map((season) => brier(
    fit.filter((s) => s.season === season),
    build(fit.filter((s) => s.season !== season)))));
}

function scoreRules(fit: Spell[], scored: Spell[]) {
  const rules: [string, Rule, number | null][] = [
    ...BUILDERS.map(([name, build]): [string, Rule, number] =>
      [name, build(fit), heldOut(fit, build)]),
    ["   the app now, B counted over every season (in sample)", (s, k) => s.now[k]!, null],
    ["   ceiling: B's table off the scored seasons", overall(scored), null],
  ];

  console.log(
    `\n## Chance he plays each of his side's next ${SCORED} games, fitted on ` +
      `${FIT_SEASONS[0]}-${FIT_SEASONS.at(-1)}, scored on ` +
      `${SCORE_SEASONS[0]}-${SCORE_SEASONS.at(-1)} (${scored.length} listings)\n`,
  );
  console.log("| rule | held out in fit | all four | next | second | third | fourth |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");

  for (const [name, rule, inFit] of rules) {
    const each = [0, 1, 2, 3].map((k) => fixed(brier(scored, rule, [k]), 4));

    console.log(
      `| ${name} | ${inFit === null ? "" : fixed(inFit, 4)} | ` +
        `${fixed(brier(scored, rule), 4)} | ${each.join(" | ")} |`,
    );
  }

  // past the fourth game the app hands back to his healthy rate, so that
  // is checked here against one flat rate for everybody
  const later = [4, 5, 6, 7];
  const flatLater = mean(fit.flatMap((s) => later
    .filter((k) => s.ahead.length > k).map((k) => Number(s.ahead[k]))));

  console.log(
    `\ngames 5 to 8, where the app hands back to his healthy rate: the app ` +
      `${fixed(brier(scored, (s, k) => s.app[k]!, later), 4)}, one flat ` +
      `${fixed(flatLater, 2)} fitted ${fixed(brier(scored, () => flatLater, later), 4)}`,
  );

  console.log("\nthe factors G was fitted on, as a share of the app's own rate");
  console.log("  " + Array.from({ length: SCORED }, (_, k) => {
    const had = fit.filter((s) => s.ahead.length > k);

    return fixed(mean(had.map((s) => Number(s.ahead[k]))) /
      mean(had.map((s) => s.app[k]!)), 3);
  }).join("  "));

  console.log("\nthe table D was fitted on, game 1 to 4");

  for (const part of [...PARTS.map(([name]) => name), "other"]) {
    const group = fit.filter((s) => s.part === part);

    console.log(`  ${part.padEnd(11)}` + Array.from({ length: SCORED },
      (_, k) => `${fixed(rateAt(group, k).rate, 3)} (${rateAt(group, k).n})`)
      .join("  "));
  }

  console.log("\nby games missed in a row, all four games");
  console.log("| rule | " + STREAK_WORDS.slice(1).join(" | ") + " |");
  console.log("| --- | --- | --- | --- |");

  for (const [name, rule] of rules.slice(0, 3).concat(rules.slice(6, 7))) {
    const each = [1, 2, 3].map((streak) =>
      fixed(brier(scored.filter((s) => s.streak === streak), rule), 4));

    console.log(`| ${name} | ${each.join(" | ")} |`);
  }

  console.log("\nthe table C was fitted on");
  console.log("| missed in a row | " +
    Array.from({ length: SCORED }, (_, k) => `game ${k + 1}`).join(" | ") + " |");
  console.log("|" + " --- |".repeat(SCORED + 1));

  for (const streak of [1, 2, 3]) {
    const group = fit.filter((s) => s.streak === streak);

    console.log(`| ${STREAK_WORDS[streak]} | ` + Array.from({ length: SCORED },
      (_, k) => `${fixed(rateAt(group, k).rate, 3)} (${rateAt(group, k).n})`)
      .join(" | ") + " |");
  }

  console.log(
    `\nthe app's chance in the next game, scored seasons: mean ` +
      `${fixed(mean(scored.map((s) => s.app[0] ?? 0)), 3)}, board games mean ` +
      `${fixed(mean(scored.map((s) => s.games)), 1)}`,
  );
}

/* ---------- the ramp ---------- */

/**
 * What the control scored in its nth game from the cut, as a share of its
 * level before, in each level band.
 */
function controlRatios(control: Control[]): number[][] {
  return BANDS.map((_, band) => {
    const inBand = control.filter((c) => bandOf(c.ppg) === band);

    return [0, 1, 2, 3].map((n) => {
      const had = inBand.filter((c) => c.after.length > n);

      return mean(had.map((c) => c.after[n]!)) / mean(had.map((c) => c.ppg));
    });
  });
}

/**
 * The nth game back against the level before, as a ratio of means, and the
 * same net of what the control in his band did over the same games.
 */
function rampOf(returns: Return[], ratios: number[][], n: number) {
  const had = returns.filter((r) => r.after.length > n);
  const scored = had.reduce((sum, r) => sum + r.after[n]!, 0);
  const before = had.reduce((sum, r) => sum + r.ppg, 0);
  const expected = had.reduce((sum, r) => sum + r.ppg * ratios[bandOf(r.ppg)]![n]!, 0);

  return { raw: scored / before, net: scored / expected, n: had.length };
}

function showRamp(returns: Return[], control: Control[]) {
  const ratios = controlRatios(control);

  console.log(
    `\n## Back from a short absence, ${returns.length} returns of players ` +
      `averaging ${MATTERS} or more, ${control.length} control cuts\n`,
  );
  console.log("| missed | returns | game 1 | game 2 | game 3 | game 4 | net 1 | net 2 | net 3-4 |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const [label, lo, hi] of [["1", 1, 1], ["2", 2, 2], ["3", 3, 3], ["1-3", 1, 3]] as const) {
    const some = returns.filter((r) => r.missed >= lo && r.missed <= hi);
    const at = [0, 1, 2, 3].map((n) => rampOf(some, ratios, n));
    const later = some.filter((r) => r.after.length > 2);
    const lateScored = later.reduce((s, r) => s + r.after.slice(2).reduce((a, b) => a + b, 0), 0);
    const lateExpected = later.reduce((s, r) => s + r.after.slice(2)
      .reduce((a, _, j) => a + r.ppg * ratios[bandOf(r.ppg)]![2 + j]!, 0), 0);

    console.log(
      `| ${label} | ${some.length} | ${at.map((a) => fixed(a.raw, 3)).join(" | ")} | ` +
        `${fixed(at[0]!.net, 3)} | ${fixed(at[1]!.net, 3)} | ${fixed(lateScored / lateExpected, 3)} |`,
    );
  }

  console.log("\nthe control's own ratio, game 1 to 4, by level band");

  BANDS.forEach((low, band) => {
    console.log(`  ${low}+: ${ratios[band]!.map((r) => fixed(r, 3)).join("  ")}`);
  });
}

/**
 * A ramp fitted on the early seasons and scored on the late ones, by MAE
 * on what he scored in his first two games back. The same factor is laid
 * on the control as well, since a skewed week of fantasy points rewards
 * any discount and the control has nothing wrong with it.
 */
function scoreRamp(returns: Return[], control: Control[]) {
  const fitReturns = returns.filter((r) => FIT_SEASONS.includes(r.season));
  const fitControl = control.filter((c) => FIT_SEASONS.includes(c.season));
  const ratios = controlRatios(fitControl);
  const twoBack = (n: number) => rampOf(fitReturns, ratios, n).net;
  const factor = (twoBack(0) + twoBack(1)) / 2;

  /** the error with no ramp and with it, game by game, and what it saved */
  const savedAt = (rows: { ppg: number; after: number[] }[], f: number) => {
    const pairs = rows.flatMap((r) => r.after.slice(0, 2)
      .map((got) => [Math.abs(r.ppg - got), Math.abs(r.ppg * f - got)] as const));
    const saved = pairs.map(([flat, ramped]) => flat - ramped);
    const average = mean(saved);
    const spread = Math.sqrt(mean(saved.map((d) => (d - average) ** 2)));

    return {
      flat: mean(pairs.map(([flat]) => flat)),
      ramped: mean(pairs.map(([, ramped]) => ramped)),
      saved: average,
      se: spread / Math.sqrt(Math.max(1, saved.length)),
      n: saved.length,
    };
  };

  const scoredReturns = returns.filter((r) => SCORE_SEASONS.includes(r.season));
  const scoredControl = control.filter((c) => SCORE_SEASONS.includes(c.season));

  console.log(
    `\n## A ramp for the first two games back, fitted at ${fixed(factor, 3)} ` +
      `on ${FIT_SEASONS[0]}-${FIT_SEASONS.at(-1)}, MAE on ` +
      `${SCORE_SEASONS[0]}-${SCORE_SEASONS.at(-1)}\n`,
  );
  console.log("| group | games | no ramp | ramp | saved | se |");
  console.log("| --- | --- | --- | --- | --- | --- |");

  const said = [["back from 1-3", scoredReturns], ["never listed", scoredControl]] as const;
  const [back, never] = said.map(([label, rows]) => {
    const got = savedAt(rows, factor);

    console.log(
      `| ${label} | ${got.n} | ${fixed(got.flat, 3)} | ${fixed(got.ramped, 3)} | ` +
        `${fixed(got.saved, 3)} | ${fixed(got.se, 3)} |`,
    );

    return got;
  });

  console.log(
    `\nnet of the control: ${fixed(back!.saved - never!.saved, 3)}, se ` +
      `${fixed(Math.sqrt(back!.se ** 2 + never!.se ** 2), 3)}`,
  );
}

/* ---------- the board's games ---------- */

/**
 * The games the board would have given each player in each season, from
 * the shipped availability model fitted on the seasons before it.
 */
async function boardGamesFor(seasons: number[]): Promise<Map<number, Map<string, number>>> {
  const earliest = 2016;
  const world = await readAvailability(
    Array.from({ length: Math.max(...seasons) - earliest + 1 }, (_, i) => earliest + i));
  const out = new Map<number, Map<string, number>>();

  for (const season of seasons) {
    const train = [];

    for (let s = earliest; s < season; s++) {
      train.push(...world.rowsFor(s));
    }

    const fit = fitAvailability(train);

    out.set(season, new Map(world.rowsFor(season)
      .map((row) => [row.playerId, predictAvailability(fit, row)])));
  }

  return out;
}

async function main() {
  const seasons = seasonsAsked(
    process.argv.slice(2), [...FIT_SEASONS, ...SCORE_SEASONS]);
  const games = await loadGames();
  const board = await boardGamesFor(seasons);
  const spells: Spell[] = [];
  const returns: Return[] = [];
  const control: Control[] = [];

  for (const season of seasons) {
    const files = await readSeason(season, games);

    spells.push(...spellsIn(files, board.get(season)!));

    const back = returnsIn(files);

    returns.push(...back.returns);
    control.push(...back.control);
  }

  console.log(
    `# Out listings against the games after them, ` +
      `${seasons[0]} to ${seasons.at(-1)}\n`,
  );

  describe(spells);

  const fit = spells.filter((s) => FIT_SEASONS.includes(s.season));
  const scored = spells.filter((s) => SCORE_SEASONS.includes(s.season));

  if (fit.length && scored.length) {
    scoreRules(fit, scored);
  }

  console.log(
    `\nB's table over every season asked, which is what the app ships: ` +
      Array.from({ length: SCORED }, (_, k) => fixed(rateAt(spells, k).rate, 3))
        .join(", "),
  );

  showRamp(returns, control);

  if (returns.some((r) => FIT_SEASONS.includes(r.season)) &&
    returns.some((r) => SCORE_SEASONS.includes(r.season))) {
    scoreRamp(returns, control);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Does a sleeper score beat the naive ways of finding a cheap player who
 * is about to be worth much more than he cost?
 *
 * At weeks 4, 6 and 8 of each season, over the players priced past 100 or
 * not drafted at all, every method picks its top twenty. The rivals are
 * the board's own order, points a game so far, raw work share, the
 * in-season update, the role level, and the model under each of its term
 * sets, against an oracle that knew the rest. Every method is scored
 * twice, over his club's remaining games with the tier on total points
 * and over the games he played with the tier on the rate.
 *
 * Run: npx tsx scripts/sleeperEval.ts [--seasons 2016-2025]
 */

import {
  build, cheap, CUTS, SEASONS, TOP_PRICED, type Row,
} from "../src/backtest/sleeperBench.js";
import {
  buildContingent, isBackup, STARTER_SNAPS, type ContingentRow,
} from "../src/backtest/contingentBench.js";
import { seasonsAsked } from "../src/data/seasons.js";
import {
  calibration, fitRoleChanceAsOf, roleChanceWeights, scoreContingent,
  type ContingentScore, type RoleChanceFit,
} from "../src/model/contingentSleepers.js";
import {
  fitSleepersAsOf, rankSleepers, sleeperTermNames,
  type SleeperExample, type SleeperFit, type SleeperScore,
  type SleeperTermSet,
} from "../src/model/sleepers.js";

/** how deep each method picks, and where precision is read */
const PICKS = 20;
const AT = [10, 20];

const TERM_SETS: SleeperTermSet[] = [
  "shipped", "with in-season", "usage", "usage with role",
  "usage, split trend",
];

/** the cut whose top ten is printed with its reasons, and under which sets */
const SHOWN_CUT = { season: 2025, week: 6 };
const SHOWN_SETS: SleeperTermSet[] = ["shipped", "usage", "usage with role"];

/* ---------- the methods, and what each one is scored on ---------- */

/** one fit's scores for one cut, keyed by player */
type Scored = Map<SleeperTermSet, Map<string, SleeperScore>>;

/** everything a method may read about the players at one cut */
interface AtCut {
  scored: Scored;
  /** the contingent parts, absent for a player with no club or no rank */
  contingent: Map<string, ContingentScore>;
}

/** what one method ranks by, biggest first */
type Order = (row: Row, at: AtCut) => number;

const by = (
  terms: SleeperTermSet, row: Row, at: AtCut,
): SleeperScore | undefined => at.scored.get(terms)?.get(row.cut.playerId);

const contingent = (row: Row, at: AtCut): ContingentScore | undefined =>
  at.contingent.get(row.cut.playerId);

const shippedScore = (row: Row, at: AtCut): number =>
  by("shipped", row, at)?.score ?? -Infinity;

const METHODS: Record<string, Order> = {
  "the price itself": (row) => -row.cut.price,
  "points a game so far": (row) => row.cut.ppgSoFar,
  "raw work share": (row) => row.cut.rawWorkShare,
  "the in-season level": (row) => row.cut.inSeasonPpg,
  "the role level": (row) => row.cut.roleLevelPpg,
  "the model": shippedScore,
  // Two ways of taking the price off the same fit, since the module's own
  // score is one reading of "what his price says" and the curve's median
  // at that price is the other.
  "the model over the curve": (row, at) => {
    const his = by("shipped", row, at);

    return his === undefined ? -Infinity : his.modelPpg - his.priceMedian;
  },
  "the model's own line": (row, at) =>
    by("shipped", row, at)?.modelPpg ?? -Infinity,
  "the model plus in-season": (row, at) =>
    by("with in-season", row, at)?.score ?? -Infinity,
  "plus in-season, own line": (row, at) =>
    by("with in-season", row, at)?.modelPpg ?? -Infinity,
  "usage, no points": (row, at) =>
    by("usage", row, at)?.score ?? -Infinity,
  "usage plus role": (row, at) =>
    by("usage with role", row, at)?.score ?? -Infinity,
  "usage, split trend": (row, at) =>
    by("usage, split trend", row, at)?.score ?? -Infinity,
  "usage, own line": (row, at) =>
    by("usage", row, at)?.modelPpg ?? -Infinity,
  "would average": (row, at) =>
    contingent(row, at)?.wouldAverage ?? -Infinity,
  "the chance it opens": (row, at) =>
    contingent(row, at)?.roleChance ?? -Infinity,
  "contingent": (row, at) => contingent(row, at)?.score ?? -Infinity,
  "model plus contingent": (row, at) =>
    shippedScore(row, at) + (contingent(row, at)?.score ?? 0),
  "better of the two": (row, at) =>
    Math.max(shippedScore(row, at), contingent(row, at)?.score ?? -Infinity),
  "oracle: the rest known": (row) => row.restOfSeasonPpg,
  "oracle: the rate known": (row) => row.restOfSeasonPerGame,
};

const NAMES = Object.keys(METHODS);

/** the pairs whose swapped picks are named, the old one first */
const COMPARED: [string, string][] = [
  ["the model", "the model plus in-season"],
  ["the model", "the in-season level"],
  ["the model", "the role level"],
  ["the model", "usage, no points"],
  ["the model", "usage plus role"],
];

function topPicks(rows: Row[], order: Order, at: AtCut): Row[] {
  return [...rows]
    .sort((a, b) => {
      const gap = order(b, at) - order(a, at);

      return gap === 0 ? a.cut.playerId.localeCompare(b.cut.playerId) : gap;
    })
    .slice(0, PICKS);
}

/** what one method's picks were worth, under both readings of the rest */
interface Tally {
  picks: number;
  points: number;
  perGamePoints: number;
  hits: Record<number, number>;
  perGameHits: Record<number, number>;
  of: Record<number, number>;
}

const atZero = () => Object.fromEntries(AT.map((deep) => [deep, 0]));

const emptyTally = (): Tally => ({
  picks: 0, points: 0, perGamePoints: 0,
  hits: atZero(), perGameHits: atZero(), of: atZero(),
});

function tallied(into: Tally, picks: Row[]): void {
  into.picks += picks.length;
  into.points += picks.reduce((sum, row) => sum + row.restOfSeasonPpg, 0);
  into.perGamePoints += picks
    .reduce((sum, row) => sum + row.restOfSeasonPerGame, 0);

  for (const deep of AT) {
    const top = picks.slice(0, deep);
    into.hits[deep] = (into.hits[deep] ?? 0) + top.filter((r) => r.hit).length;
    into.perGameHits[deep] = (into.perGameHits[deep] ?? 0)
      + top.filter((r) => r.hitPerGame).length;
    into.of[deep] = (into.of[deep] ?? 0) + top.length;
  }
}

const per = (points: number, picks: number) =>
  picks === 0 ? 0 : points / picks;

const share = (hits: number | undefined, of: number | undefined) =>
  (of ?? 0) === 0 ? 0 : (hits ?? 0) / of!;

/** one reading of what happened after the cut, and how it scores a pick */
interface Outcome {
  name: string;
  /** the same thing said inside the width of a column group */
  short: string;
  ppg: (tally: Tally) => number;
  hits: (tally: Tally, deep: number) => number;
  precision: (tally: Tally, deep: number) => number;
}

const OUTCOMES: Outcome[] = [
  {
    name: "over his club's games, tier on total points",
    short: "club games, on the total",
    ppg: (tally) => per(tally.points, tally.picks),
    hits: (tally, deep) => tally.hits[deep] ?? 0,
    precision: (tally, deep) => share(tally.hits[deep], tally.of[deep]),
  },
  {
    name: "over the games he played, tier on the rate",
    short: "games played, on the rate",
    ppg: (tally) => per(tally.perGamePoints, tally.picks),
    hits: (tally, deep) => tally.perGameHits[deep] ?? 0,
    precision: (tally, deep) => share(tally.perGameHits[deep], tally.of[deep]),
  },
];

const perPick = (tally: Tally) => per(tally.points, tally.picks);

const precision = (tally: Tally, deep: number) =>
  share(tally.hits[deep], tally.of[deep]);

/** every tally one run keeps, pooled and cut up three ways */
interface Kept {
  pooled: Map<string, Tally>;
  bySeason: Map<string, Map<number, Tally>>;
  byCut: Map<string, Map<number, Tally>>;
  byPosition: Map<string, Map<string, Tally>>;
  /** each method's picks, one array per cut, in the same order for all */
  picked: Map<string, Row[][]>;
}

const emptyKept = (): Kept => ({
  pooled: new Map(NAMES.map((name) => [name, emptyTally()])),
  bySeason: new Map(NAMES.map((name) => [name, new Map<number, Tally>()])),
  byCut: new Map(NAMES.map((name) => [name, new Map<number, Tally>()])),
  byPosition: new Map(NAMES.map((name) => [name, new Map<string, Tally>()])),
  picked: new Map(NAMES.map((name) => [name, []])),
});

function into<K>(tallies: Map<K, Tally>, key: K, picks: Row[]): void {
  const tally = tallies.get(key) ?? emptyTally();
  tallied(tally, picks);
  tallies.set(key, tally);
}

function keep(
  kept: Kept, name: string, season: number, week: number, picks: Row[],
): void {
  tallied(kept.pooled.get(name)!, picks);
  into(kept.bySeason.get(name)!, season, picks);
  into(kept.byCut.get(name)!, week, picks);
  kept.picked.get(name)!.push(picks);

  for (const position of new Set(picks.map((row) => row.cut.position))) {
    into(
      kept.byPosition.get(name)!,
      position,
      picks.filter((row) => row.cut.position === position),
    );
  }
}

/* ---------- the second outcome: did the job come to him ---------- */

/** what one method's picks did about taking a job, over one population */
interface RoleTally {
  picks: number;
  /** how many went on to average a starter's share of the snaps */
  started: number;
  /** what those ones averaged over the games they played */
  pointsWhenStarted: number;
  /** and what all the picks averaged */
  points: number;
}

const emptyRole = (): RoleTally => ({
  picks: 0, started: 0, pointsWhenStarted: 0, points: 0,
});

function talliedRole(
  into: RoleTally, picks: Row[], opened: Map<string, ContingentRow>,
): void {
  for (const pick of picks) {
    const his = opened.get(pick.cut.playerId);
    into.picks++;
    into.points += pick.restOfSeasonPerGame;

    if (his?.becameStarter) {
      into.started++;
      into.pointsWhenStarted += pick.restOfSeasonPerGame;
    }
  }
}

/** every method over the backups, and how many of them the job came to */
interface RoleKept {
  pooled: Map<string, RoleTally>;
  candidates: number;
  opened: number;
}

const emptyRoleKept = (): RoleKept => ({
  pooled: new Map(NAMES.map((name) => [name, emptyRole()])),
  candidates: 0,
  opened: 0,
});

function reportRole(kept: RoleKept, title: string): void {
  console.log(
    `\n${title}: ${kept.candidates} candidates, ${kept.opened} of them went ` +
    `on to average ${(STARTER_SNAPS * 100).toFixed(0)}% of the snaps`,
  );
  console.log(
    `${"method".padEnd(25)}  starters  of picks   rate   ppg when they did` +
    "   ppg overall",
  );

  for (const name of NAMES) {
    const tally = kept.pooled.get(name)!;
    const rate = tally.picks === 0 ? 0 : tally.started / tally.picks;
    const when = tally.started === 0
      ? 0 : tally.pointsWhenStarted / tally.started;
    console.log(
      `${name.padEnd(25)}  ${String(tally.started).padStart(8)}` +
      `  ${String(tally.picks).padStart(8)}  ${rate.toFixed(3)}` +
      `  ${when.toFixed(2).padStart(17)}` +
      `  ${per(tally.points, tally.picks).toFixed(2).padStart(12)}`,
    );
  }
}

/**
 * What the chance is built on and whether it means what it says. Every
 * chance here came from a fit that had not seen the season it scored, so
 * the deciles are out of sample.
 */
function reportChance(
  fit: RoleChanceFit,
  marked: { chance: number; becameStarter: boolean }[],
): void {
  console.log(
    `\nwhat the ${fit.trainedOn[0]} to ` +
    `${fit.trainedOn[fit.trainedOn.length - 1]} role chance fit weighs, in ` +
    "chance per deviation",
  );

  for (const { term, weight } of roleChanceWeights(fit)) {
    console.log(`  ${term.padEnd(26)}${weight.toFixed(3)}`);
  }

  console.log("\nthe chance against what happened, in deciles of the chance");
  console.log("  band          players    said     was");

  for (const bin of calibration(marked)) {
    console.log(
      `  ${bin.low.toFixed(2)} to ${bin.high.toFixed(2)}` +
      `  ${String(bin.players).padStart(7)}` +
      `   ${bin.predicted.toFixed(3)}   ${bin.realized.toFixed(3)}`,
    );
  }
}

/** the contingent picks at one cut, for reading by eye */
function reportNearest(
  title: string, picks: ContingentScore[],
  opened: Map<string, ContingentRow>,
): void {
  console.log(`\n${title}`);

  for (const pick of picks) {
    const his = opened.get(pick.playerId);
    console.log(
      `  ${pick.playerName.slice(0, 20).padEnd(20)} ${pick.position} ` +
      `${(pick.roleChance * 100).toFixed(0).padStart(3)}% chance, would ` +
      `average ${pick.wouldAverage.toFixed(1)} against the ` +
      `${pick.pricePpg.toFixed(1)} his price says, score ` +
      `${pick.score.toFixed(2)}; ` +
      `${his?.becameStarter ? "took the job" : "did not"}, ` +
      `${his?.row.restOfSeasonPerGame.toFixed(1) ?? "0.0"} a game after`,
    );
  }
}

/* ---------- printing ---------- */

const middleOf = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};

/** one method's cells under one outcome: ppg a pick, then the two tiers */
const cellsFor = (outcome: Outcome, tally: Tally) =>
  `  ${outcome.ppg(tally).toFixed(2).padStart(5)}` +
  `  ${outcome.precision(tally, 10).toFixed(3)}` +
  `  ${outcome.precision(tally, 20).toFixed(3)}` +
  `  ${String(outcome.hits(tally, 20)).padStart(3)}`;

function reportPooled(kept: Kept): void {
  console.log(
    `\n${"".padEnd(25)}${OUTCOMES
      .map((outcome) => outcome.short.padEnd(26)).join("")}`,
  );
  console.log(
    `${"method".padEnd(25)}${OUTCOMES
      .map(() => "    ppg  p@10   p@20  h@20").join("")}   picks`,
  );

  for (const name of NAMES) {
    const tally = kept.pooled.get(name)!;
    console.log(
      `${name.padEnd(25)}` +
      `${OUTCOMES.map((outcome) => cellsFor(outcome, tally)).join("")}` +
      `   ${String(tally.picks).padStart(5)}`,
    );
  }
}

/** a pooled gain can be one season carrying the rest, so spread them out */
function reportSeasonSpread(kept: Kept): void {
  console.log("\nppg a pick by season: worst, median, best");
  console.log(
    `${"method".padEnd(25)}${OUTCOMES
      .map(() => "   worst  median    best").join("")}`,
  );

  for (const name of NAMES) {
    const tallies = [...(kept.bySeason.get(name) ?? new Map()).values()];
    const cells = OUTCOMES.map((outcome) => {
      const seasons = tallies.map(outcome.ppg);

      return `  ${Math.min(...seasons).toFixed(2).padStart(6)}` +
        `  ${middleOf(seasons).toFixed(2).padStart(6)}` +
        `  ${Math.max(...seasons).toFixed(2).padStart(6)}`;
    });
    console.log(`${name.padEnd(25)}${cells.join("")}`);
  }
}

/** every method at every cut, since week 4 and week 8 are not one question */
function reportByCut(kept: Kept, outcome: Outcome): void {
  console.log(
    `\nby cut, ${outcome.name}. ppg a pick, then hits of ${PICKS} a cut ` +
    `and precision at ${PICKS}`,
  );
  console.log(
    "".padEnd(25) + CUTS.map((week) => `        week ${week}`).join(""),
  );

  for (const name of NAMES) {
    const cells = CUTS.map((week) => {
      const tally = kept.byCut.get(name)!.get(week) ?? emptyTally();

      return `  ${outcome.ppg(tally).toFixed(2).padStart(5)} ` +
        `${String(outcome.hits(tally, 20)).padStart(3)} ` +
        `${outcome.precision(tally, 20).toFixed(3)}`;
    });
    console.log(`${name.padEnd(25)}${cells.join("")}`);
  }
}

const POSITIONS = ["QB", "RB", "WR", "TE"];

/** who each method picks, since the old model is known to skip passers */
function reportByPosition(kept: Kept): void {
  console.log("\nwhere the picks went, as hits of picks by position");
  console.log(
    "".padEnd(25) + POSITIONS.map((one) => one.padStart(11)).join(""),
  );

  for (const name of NAMES) {
    const cells = POSITIONS.map((position) => {
      const tally = kept.byPosition.get(name)!.get(position) ?? emptyTally();

      return `${String(tally.hits[20] ?? 0)} of ${tally.picks}`.padStart(11);
    });
    console.log(`${name.padEnd(25)}${cells.join("")}`);
  }
}

/**
 * How many seasons each method beat each other one. A pooled gain of half
 * a point could be one season carrying the rest, and a row that reads
 * three of seven says so.
 */
function reportHeadToHead(
  kept: Kept,
  measure: string,
  read: (tally: Tally) => number,
): void {
  const bySeason = kept.bySeason;
  const seasons = [...(bySeason.get(NAMES[0]!) ?? new Map()).keys()].sort();
  console.log(`\nseasons won on ${measure}, out of ${seasons.length}`);
  console.log(
    `${"".padEnd(25)}${NAMES.map((n) => n.slice(0, 7).padStart(8)).join("")}`,
  );

  for (const name of NAMES) {
    const mine = bySeason.get(name)!;
    const cells = NAMES.map((other) => {
      if (other === name) {
        return "-".padStart(8);
      }

      const theirs = bySeason.get(other)!;
      const won = seasons.filter((season) =>
        read(mine.get(season)!) > read(theirs.get(season)!)).length;

      return String(won).padStart(8);
    });
    console.log(`${name.padEnd(25)}${cells.join("")}`);
  }
}

/**
 * What the last fit weighs each term at, in points a game per standard
 * deviation, so the terms can be read against each other.
 */
function reportWeights(fit: SleeperFit): void {
  const terms = sleeperTermNames(fit.terms);
  console.log(
    `\nwhat the ${fit.trainedOn[0]} to ` +
    `${fit.trainedOn[fit.trainedOn.length - 1]} ${fit.terms} fit weighs, in ` +
    "points a game per deviation",
  );
  console.log(`  intercept${" ".repeat(15)}${fit.weights[0]!.toFixed(2)}`);

  for (let i = 0; i < terms.length; i++) {
    console.log(
      `  ${terms[i]!.padEnd(24)}${fit.weights[i + 1]!.toFixed(2)}`,
    );
  }
}

/** the reasons behind one cut's top few, since a bare ranking is no use */
function reportReasons(
  season: number, week: number, picks: SleeperScore[], terms: SleeperTermSet,
): void {
  console.log(
    `\nwhat the ${terms} model said in ${season} after week ${week}`,
  );

  for (const pick of picks) {
    const price = pick.drafted ? `pick ${pick.price.toFixed(0)}` : "undrafted";
    const said = (value: number) =>
      `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
    console.log(
      `  ${pick.playerName} (${pick.position}, ${price}) ${said(pick.score)} ` +
      `a game over the ${pick.pricePpg.toFixed(2)} his price says, and ` +
      `${pick.modelPpg.toFixed(2)} from here`,
    );
    console.log(
      `      ${pick.reasons.slice(0, 3)
        .map((one) => `${one.term} ${said(one.points)}`).join(", ")}`,
    );
  }
}

/* ---------- how well each line predicts the rest of the season ---------- */

/** what one reader says a candidate does from here */
const LINES: Record<string, (row: Row, at: AtCut) => number> = {
  "the price median": (row) => row.cut.priceMedian,
  "points a game so far": (row) => row.cut.ppgSoFar,
  "the in-season level": (row) => row.cut.inSeasonPpg,
  "the role level": (row) => row.cut.roleLevelPpg,
  "the model's own line": (row, at) =>
    by("shipped", row, at)?.modelPpg ?? 0,
  "plus in-season, own line": (row, at) =>
    by("with in-season", row, at)?.modelPpg ?? 0,
};

const mean = (values: number[]) =>
  values.reduce((sum, one) => sum + one, 0) / Math.max(1, values.length);

function correlation(said: number[], was: number[]): number {
  const middleSaid = mean(said);
  const middleWas = mean(was);
  const together = said
    .map((one, i) => (one - middleSaid) * (was[i]! - middleWas));
  const spread = (values: number[], middle: number) =>
    values.map((one) => (one - middle) ** 2);

  return mean(together) / Math.sqrt(
    mean(spread(said, middleSaid)) * mean(spread(was, middleWas)),
  );
}

/** one reader's numbers at one cut, against what the players went on to do */
interface Said {
  said: number[];
  was: number[];
}

/**
 * A ranking says nothing about whether the level itself is any good, and
 * the in-season update was built to answer the rest of the season, so it
 * is marked on that here over the same candidates.
 */
function reportLines(lines: Map<string, Map<number, Said>>): void {
  console.log(
    "\nrest of season over the cheap candidates, MAE then correlation",
  );
  console.log(
    "".padEnd(25) + CUTS.map((week) => `      week ${week}`).join(""),
  );

  for (const [name, byCut] of lines) {
    const cells = CUTS.map((week) => {
      const kept = byCut.get(week) ?? { said: [], was: [] };
      const off = kept.said.map((one, i) => Math.abs(one - kept.was[i]!));

      return `  ${mean(off).toFixed(2).padStart(5)} ` +
        `${correlation(kept.said, kept.was).toFixed(3)}`;
    });
    console.log(`${name.padEnd(25)}${cells.join("")}`);
  }
}

/* ---------- who the two orders disagree about ---------- */

const SHOWN = 12;

const named = (row: Row): string => {
  const cut = row.cut;
  const price = cut.drafted ? `pick ${cut.price.toFixed(0)}` : "undrafted";

  return `  ${cut.playerName.slice(0, 20).padEnd(20)} ${cut.position} ` +
    `${String(cut.season)} wk${String(cut.week).padStart(2)} ` +
    `${price.padEnd(10)} ppg ${cut.ppgSoFar.toFixed(1).padStart(5)}` +
    `  level ${cut.inSeasonPpg.toFixed(1).padStart(5)}` +
    `  role ${cut.roleLevelPpg.toFixed(1).padStart(5)}` +
    `  rest ${row.restOfSeasonPpg.toFixed(1).padStart(5)}` +
    `  a game ${row.restOfSeasonPerGame.toFixed(1).padStart(5)}` +
    `  ${row.hit ? "hit" : "no "} ${row.hitPerGame ? "hit" : "no "}`;
};

function listed(title: string, rows: Row[]): void {
  console.log(`  ${title}: ${rows.length}`);

  for (const row of rows.slice(0, SHOWN)) {
    console.log(named(row));
  }
}

/** the players one order picks and the other does not, and how they went */
function reportSwaps(kept: Kept, before: string, after: string): void {
  const gained: Row[] = [];
  const lost: Row[] = [];
  const old = kept.picked.get(before)!;

  kept.picked.get(after)!.forEach((picks, i) => {
    const had = new Set((old[i] ?? []).map((row) => row.cut.playerId));
    const has = new Set(picks.map((row) => row.cut.playerId));
    gained.push(...picks.filter((row) => !had.has(row.cut.playerId)));
    lost.push(...(old[i] ?? [])
      .filter((row) => !has.has(row.cut.playerId)));
  });

  const worst = (rows: Row[]) => [...rows]
    .sort((a, b) => a.tierMargin - b.tierMargin);
  const best = (rows: Row[]) => [...rows]
    .sort((a, b) => b.restOfSeasonPpg - a.restOfSeasonPpg);
  console.log(`\n${after} against ${before}, over the same ${PICKS} a cut`);
  listed("added and hit", best(gained.filter((row) => row.hit)));
  listed("added and missed", worst(gained.filter((row) => !row.hit)));
  listed("dropped, and they hit", best(lost.filter((row) => row.hit)));
  console.log(
    `  dropped and they missed: ${lost.filter((row) => !row.hit).length}`,
  );
}

/* ---------- main ---------- */

async function main(): Promise<void> {
  const seasons = seasonsAsked(process.argv, SEASONS);
  const { rows, priced, skipped } = await build(seasons);
  const examples: SleeperExample[] = rows.map((row) => ({
    cut: row.cut, restOfSeasonPpg: row.restOfSeasonPpg,
  }));
  const contingentRows = (await buildContingent(rows, CUTS)).rows;
  const backups = contingentRows.filter(isBackup);
  const atCut = (season: number, week: number, playerId: string) =>
    `${season}|${week}|${playerId}`;
  const byPlayer = new Map(contingentRows.map((one) =>
    [atCut(one.cut.season, one.cut.week, one.cut.playerId), one]));
  const roleKept = emptyRoleKept();
  const stillBehind = emptyRoleKept();
  const marked: { chance: number; becameStarter: boolean }[] = [];
  let lastChanceFit: RoleChanceFit | undefined;
  let nearest: {
    scored: ContingentScore[]; opened: Map<string, ContingentRow>;
  } | undefined;
  const kept = emptyKept();
  const lines = new Map(Object.keys(LINES).map((name) =>
    [name, new Map(CUTS.map((week) => [week, { said: [], was: [] } as Said]))]));
  const scorable = priced.filter((season) => season > (priced[0] ?? Infinity));
  let last: { season: number; week: number; picks: SleeperScore[] } | undefined;
  const shown = new Map<SleeperTermSet, SleeperScore[]>();

  if (scorable.length === 0) {
    console.log(
      "nothing to score: no season asked for has both a price curve and an " +
      "earlier season of cuts to fit on",
    );

    for (const [season, why] of skipped) {
      console.log(`  ${season} is out: ${why}`);
    }

    return;
  }

  for (const season of scorable) {
    const fits = new Map(TERM_SETS.map((terms) =>
      [terms, fitSleepersAsOf(season, examples, { terms })]));
    const chanceFit = fitRoleChanceAsOf(season, backups);
    lastChanceFit = chanceFit;

    for (const week of CUTS) {
      const population = rows.filter((row) =>
        row.cut.season === season && row.cut.week === week && cheap(row));
      const scored: Scored = new Map();

      for (const [terms, fit] of fits) {
        const ranked = rankSleepers(fit, population.map((row) => row.cut));
        scored.set(terms, new Map(ranked.map((one) => [one.playerId, one])));

        if (terms === "shipped") {
          last = { season, week, picks: ranked.slice(0, 5) };
        }

        if (season === SHOWN_CUT.season && week === SHOWN_CUT.week
          && SHOWN_SETS.includes(terms)) {
          shown.set(terms, ranked.slice(0, 10));
        }
      }

      const mine = population
        .map((row) => byPlayer.get(atCut(season, week, row.cut.playerId)))
        .filter((one): one is ContingentRow => one !== undefined);
      const at: AtCut = {
        scored,
        contingent: new Map(mine.map((one) =>
          [one.cut.playerId, scoreContingent(chanceFit, one.cut)])),
      };
      const behind = mine.filter(isBackup);
      const opened = new Map(behind.map((one) => [one.cut.playerId, one]));
      const notYet = behind
        .filter((one) => one.cut.snapShare < STARTER_SNAPS);
      const notYetOpened = new Map(notYet.map((one) =>
        [one.cut.playerId, one]));
      const behindRows = behind.map((one) => one.row);
      const notYetRows = notYet.map((one) => one.row);

      roleKept.candidates += behind.length;
      roleKept.opened += behind.filter((one) => one.becameStarter).length;
      stillBehind.candidates += notYet.length;
      stillBehind.opened += notYet.filter((one) => one.becameStarter).length;

      for (const one of behind) {
        marked.push({
          chance: at.contingent.get(one.cut.playerId)!.roleChance,
          becameStarter: one.becameStarter,
        });
      }

      if (season === SHOWN_CUT.season && week === SHOWN_CUT.week) {
        nearest = {
          scored: behind.map((one) => at.contingent.get(one.cut.playerId)!),
          opened,
        };
      }

      for (const name of NAMES) {
        const order = METHODS[name]!;
        keep(kept, name, season, week, topPicks(population, order, at));
        talliedRole(
          roleKept.pooled.get(name)!, topPicks(behindRows, order, at), opened,
        );
        talliedRole(
          stillBehind.pooled.get(name)!,
          topPicks(notYetRows, order, at),
          notYetOpened,
        );
      }

      for (const [name, line] of Object.entries(LINES)) {
        const mark = lines.get(name)!.get(week)!;

        for (const row of population) {
          mark.said.push(line(row, at));
          mark.was.push(row.restOfSeasonPpg);
        }
      }
    }
  }

  const lastSeason = scorable[scorable.length - 1]!;
  console.log(
    `weeks ${CUTS.join(", ")} of ${scorable[0]} to ` +
    `${lastSeason}, over the players priced past ` +
    `${TOP_PRICED} or undrafted, in PPR. Each method picks ${PICKS}.`,
  );
  const fitted = fitSleepersAsOf(lastSeason, examples);
  console.log(
    `${rows.length} player cuts over ${priced.length} seasons, ` +
    `${rows.filter(cheap).length} of them cheap enough to be picked from. ` +
    `The last fit read ${fitted.examples} rows over ` +
    `${fitted.trainedOn.length} seasons.`,
  );

  for (const [season, why] of skipped) {
    console.log(`  ${season} is out: ${why}`);
  }

  if (priced.length > 0 && scorable.length < priced.length) {
    console.log(
      `  ${priced[0]} is out of the scoring: it is the first season with a ` +
      "price curve, so there are no earlier cuts to fit on",
    );
  }

  reportPooled(kept);
  reportRole(
    roleKept,
    "second outcome: the top twenty among the players ranked 2 or 3 at " +
    "their position",
  );
  reportRole(
    stillBehind,
    "the same, over only the ones under a starter's share at the cut",
  );

  if (lastChanceFit) {
    reportChance(lastChanceFit, marked);
  }

  reportSeasonSpread(kept);

  for (const outcome of OUTCOMES) {
    reportByCut(kept, outcome);
  }

  reportByPosition(kept);
  reportHeadToHead(kept, "the points a pick returned", perPick);
  reportHeadToHead(kept, "precision at 20", (tally) => precision(tally, 20));
  reportHeadToHead(
    kept, "precision at 20 on the rate",
    (tally) => OUTCOMES[1]!.precision(tally, 20),
  );
  reportLines(lines);

  for (const terms of TERM_SETS) {
    reportWeights(fitSleepersAsOf(lastSeason, examples, { terms }));
  }

  for (const [before, after] of COMPARED) {
    reportSwaps(kept, before, after);
  }

  for (const [terms, picks] of shown) {
    reportReasons(SHOWN_CUT.season, SHOWN_CUT.week, picks, terms);
  }

  if (nearest) {
    const when = `in ${SHOWN_CUT.season} after week ${SHOWN_CUT.week}`;
    const deepest = (read: (one: ContingentScore) => number) =>
      [...nearest!.scored].sort((a, b) => read(b) - read(a)).slice(0, PICKS);
    reportNearest(
      `who the contingent score liked ${when}`,
      deepest((one) => one.score), nearest.opened,
    );
    reportNearest(
      `who was nearest a job ${when}, by the chance alone`,
      deepest((one) => one.roleChance), nearest.opened,
    );
  }

  if (last && shown.size === 0) {
    reportReasons(last.season, last.week, last.picks, "shipped");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

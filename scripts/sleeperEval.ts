/**
 * Does a sleeper score beat the naive ways of finding a cheap player who
 * is about to be worth much more than he cost?
 *
 * At weeks 4, 6 and 8 of each season, over the players priced past 100 or
 * not drafted at all, every method picks its top twenty and is scored on
 * what those players went on to average and on how many of them finished
 * inside the tier a league starts. The rivals are the board's own order,
 * points a game so far, raw work share, and the model, with an oracle
 * that knew the rest of the season as the ceiling.
 *
 * Run: npx tsx scripts/sleeperEval.ts [--seasons 2016-2025]
 */

import { loadAdp, type AdpEntry } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { loadPlayerStats, type PlayerWeekStats } from "../src/data/nflverse.js";
import { seasonsAsked } from "../src/data/seasons.js";
import {
  marketPriceAsOf, PRICED_POSITIONS, STARTER_TIER,
  type MarketPrice, type SeasonPrices,
} from "../src/features/marketPrice.js";
import {
  leverageUsage, loadLeverage, type LeverageRow, type Usage,
} from "../src/features/leverageUsage.js";
import {
  fitSleepersAsOf, rankSleepers, SLEEPER_TERMS, UNDRAFTED_PRICE,
  type PlayerCut, type SleeperExample, type SleeperFit, type SleeperScore,
} from "../src/model/sleepers.js";
import { fantasyPoints, scoringRules } from "../src/scoring/fantasyPoints.js";

const SEASONS = Array.from({ length: 10 }, (_, i) => 2016 + i);

/** the weeks a drafter is still able to do something about it */
const CUTS = [4, 6, 8];

/** past this pick a player is cheap enough to be worth calling a sleeper */
const TOP_PRICED = 100;

/** how deep each method picks, and where precision is read */
const PICKS = 20;
const AT = [10, 20];

const RULES = scoringRules("ppr");
const LAST_WEEK = 18;

/* ---------- one season, read once ---------- */

/** everything one season's stat file says, keyed by player id */
interface SeasonWeeks {
  positions: Map<string, string>;
  names: Map<string, string>;
  points: Map<string, Map<number, number>>;
  /** the weeks each club played, so a missed game can count as a zero */
  clubWeeks: Map<string, Set<number>>;
  /** which club he appeared for each week, for the players with no work */
  clubBy: Map<string, Map<number, string>>;
}

function readSeason(weeks: PlayerWeekStats[]): SeasonWeeks {
  const read: SeasonWeeks = {
    positions: new Map(), names: new Map(), points: new Map(),
    clubWeeks: new Map(), clubBy: new Map(),
  };

  for (const week of weeks) {
    if (week.position) {
      read.positions.set(week.playerId, week.position);
    }

    read.names.set(week.playerId, week.playerName);
    const his = read.points.get(week.playerId) ?? new Map<number, number>();
    his.set(week.week, fantasyPoints(week.statLine, RULES));
    read.points.set(week.playerId, his);

    const played = read.clubWeeks.get(week.teamId) ?? new Set<number>();
    played.add(week.week);
    read.clubWeeks.set(week.teamId, played);

    const clubs = read.clubBy.get(week.playerId) ?? new Map<number, string>();
    clubs.set(week.week, week.teamId);
    read.clubBy.set(week.playerId, clubs);
  }

  return read;
}

/** the board keyed by name alone, since a stat file and a board can disagree */
function boardByName(board: Map<string, AdpEntry>): Map<string, AdpEntry[]> {
  const byName = new Map<string, AdpEntry[]>();

  for (const entry of board.values()) {
    const key = normalizeName(entry.name);
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }

  return byName;
}

function pricedAs(
  byName: Map<string, AdpEntry[]>, name: string, position: string,
): AdpEntry | undefined {
  const entries = byName.get(normalizeName(name)) ?? [];
  const atPosition = entries.filter((one) => one.position === position);

  return [...(atPosition.length > 0 ? atPosition : entries)]
    .sort((a, b) => a.adp - b.adp)[0];
}

/* ---------- what a player had done, and what he went on to do ---------- */

/** his points over a stretch of weeks, and how many of them he played */
function over(
  his: Map<number, number> | undefined, from: number, to: number,
): { points: number; games: number } {
  let points = 0;
  let games = 0;

  for (let week = from; week <= to; week++) {
    const scored = his?.get(week);

    if (scored === undefined) {
      continue;
    }

    points += scored;
    games++;
  }

  return { points, games };
}

/** the club he did most of his work for up to the cut */
function clubAt(
  read: SeasonWeeks, playerId: string, usage: Usage | undefined, week: number,
): string {
  if (usage?.team) {
    return usage.team;
  }

  const clubs = read.clubBy.get(playerId);

  for (let earlier = week; earlier >= 1; earlier--) {
    const club = clubs?.get(earlier);

    if (club) {
      return club;
    }
  }

  return "";
}

/** one row of the bench: the features at the cut and the truth after it */
interface Row {
  cut: PlayerCut;
  restOfSeasonPpg: number;
  restOfSeasonTotal: number;
  /** he finished inside his position's starter tier over those weeks */
  hit: boolean;
}

function cutsFor(
  season: number,
  week: number,
  read: SeasonWeeks,
  curve: MarketPrice,
  byName: Map<string, AdpEntry[]>,
  counted: LeverageRow[],
): Row[] {
  const usage = leverageUsage(counted, {
    season, through: week, positions: read.positions,
  });
  const rows: Row[] = [];

  for (const [playerId, position] of read.positions) {
    if (!PRICED_POSITIONS.includes(position)) {
      continue;
    }

    const his = read.points.get(playerId);
    const already = over(his, 1, week);

    if (already.games === 0) {
      continue;
    }

    const name = read.names.get(playerId) ?? "";
    const mine = usage.get(playerId);
    const club = clubAt(read, playerId, mine, week);
    const left = [...(read.clubWeeks.get(club) ?? [])]
      .filter((one) => one > week).length;

    if (left === 0) {
      continue;
    }

    const entry = pricedAs(byName, name, position);
    const price = entry?.adp ?? UNDRAFTED_PRICE;
    const quantiles = curve.quantiles(position, price);
    const rest = over(his, week + 1, LAST_WEEK);
    rows.push({
      cut: {
        season, week, playerId, playerName: name, position,
        price, drafted: entry !== undefined,
        priceMedian: quantiles.p50,
        priceP10: quantiles.p10,
        priceP90: quantiles.p90,
        priceHitRate: curve.hitRate(position, price),
        rawWorkShare: mine?.rawWorkShare ?? 0,
        leverageWorkShare: mine?.workShare ?? 0,
        trend: (mine?.targetTrend ?? 0) + (mine?.carryTrend ?? 0),
        ppgSoFar: already.points / already.games,
        gamesPlayed: already.games,
        pickSpread: entry?.stdev === undefined
          ? 0 : entry.stdev / Math.max(1, entry.adp),
        hasPickSpread: entry?.stdev !== undefined,
      },
      restOfSeasonPpg: rest.points / left,
      restOfSeasonTotal: rest.points,
      hit: false,
    });
  }

  return marked(rows);
}

/**
 * Who finished inside the starter tier over the rest of the season, on
 * total points rather than on a rate, so the weeks a player missed count
 * against him the way they do in a league.
 */
function marked(rows: Row[]): Row[] {
  for (const position of PRICED_POSITIONS) {
    const tier = STARTER_TIER[position];
    const ranked = rows
      .filter((row) => row.cut.position === position)
      .sort((a, b) => b.restOfSeasonTotal - a.restOfSeasonTotal);
    const tierCut = tier === undefined
      ? Infinity
      : ranked[tier - 1]?.restOfSeasonTotal ?? -Infinity;

    for (const row of ranked) {
      row.hit = row.restOfSeasonTotal >= tierCut;
    }
  }

  return rows;
}

/* ---------- the methods, and what each one is scored on ---------- */

/** what one method ranks by, biggest first */
type Order = (row: Row, scored: Map<string, SleeperScore>) => number;

const METHODS: Record<string, Order> = {
  "the price itself": (row) => -row.cut.price,
  "points a game so far": (row) => row.cut.ppgSoFar,
  "raw work share": (row) => row.cut.rawWorkShare,
  "the model": (row, scored) =>
    scored.get(row.cut.playerId)?.score ?? -Infinity,
  // Two ways of taking the price off the same fit, since the module's own
  // score is one reading of "what his price says" and the curve's median
  // at that price is the other.
  "the model over the curve": (row, scored) => {
    const his = scored.get(row.cut.playerId);

    return his === undefined ? -Infinity : his.modelPpg - his.priceMedian;
  },
  "the model's own line": (row, scored) =>
    scored.get(row.cut.playerId)?.modelPpg ?? -Infinity,
  "oracle: the rest known": (row) => row.restOfSeasonPpg,
};

const NAMES = Object.keys(METHODS);

function topPicks(
  rows: Row[], order: Order, scored: Map<string, SleeperScore>,
): Row[] {
  return [...rows]
    .sort((a, b) => {
      const gap = order(b, scored) - order(a, scored);

      return gap === 0 ? a.cut.playerId.localeCompare(b.cut.playerId) : gap;
    })
    .slice(0, PICKS);
}

/** what one method's picks were worth */
interface Tally {
  picks: number;
  points: number;
  hits: Record<number, number>;
  of: Record<number, number>;
}

const emptyTally = (): Tally => ({
  picks: 0, points: 0,
  hits: Object.fromEntries(AT.map((deep) => [deep, 0])),
  of: Object.fromEntries(AT.map((deep) => [deep, 0])),
});

function tallied(into: Tally, picks: Row[]): void {
  into.picks += picks.length;
  into.points += picks.reduce((sum, row) => sum + row.restOfSeasonPpg, 0);

  for (const deep of AT) {
    const top = picks.slice(0, deep);
    into.hits[deep] = (into.hits[deep] ?? 0) + top.filter((r) => r.hit).length;
    into.of[deep] = (into.of[deep] ?? 0) + top.length;
  }
}

const perPick = (tally: Tally) =>
  tally.picks === 0 ? 0 : tally.points / tally.picks;

const precision = (tally: Tally, deep: number) =>
  (tally.of[deep] ?? 0) === 0 ? 0 : (tally.hits[deep] ?? 0) / tally.of[deep]!;

/* ---------- printing ---------- */

const middleOf = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};

function reportPooled(
  pooled: Map<string, Tally>, bySeason: Map<string, Map<number, Tally>>,
): void {
  console.log(
    "\nmethod                    ppg a pick   prec@10   prec@20   picks" +
    "   worst season  median   best",
  );

  for (const name of NAMES) {
    const tally = pooled.get(name)!;
    const seasons = [...(bySeason.get(name) ?? new Map()).values()]
      .map(perPick);
    console.log(
      `${name.padEnd(25)} ${perPick(tally).toFixed(2).padStart(6)}` +
      `   ${precision(tally, 10).toFixed(3).padStart(7)}` +
      `   ${precision(tally, 20).toFixed(3).padStart(7)}` +
      `   ${String(tally.picks).padStart(5)}` +
      `   ${Math.min(...seasons).toFixed(2).padStart(12)}` +
      `  ${middleOf(seasons).toFixed(2).padStart(6)}` +
      `  ${Math.max(...seasons).toFixed(2).padStart(5)}`,
    );
  }
}

/**
 * How many seasons each method beat each other one. A pooled gain of half
 * a point could be one season carrying the rest, and a row that reads
 * three of seven says so.
 */
function reportHeadToHead(
  bySeason: Map<string, Map<number, Tally>>,
  measure: string,
  read: (tally: Tally) => number,
): void {
  const seasons = [...(bySeason.get(NAMES[0]!) ?? new Map()).keys()].sort();
  console.log(`\nseasons won on ${measure}, out of ${seasons.length}`);
  console.log(
    `${"".padEnd(25)}${NAMES.map((n) => n.slice(0, 8).padStart(9)).join("")}`,
  );

  for (const name of NAMES) {
    const mine = bySeason.get(name)!;
    const cells = NAMES.map((other) => {
      if (other === name) {
        return "-".padStart(9);
      }

      const theirs = bySeason.get(other)!;
      const won = seasons.filter((season) =>
        read(mine.get(season)!) > read(theirs.get(season)!)).length;

      return String(won).padStart(9);
    });
    console.log(`${name.padEnd(25)}${cells.join("")}`);
  }
}

/**
 * What the last fit weighs each term at, in points a game per standard
 * deviation, so the terms can be read against each other.
 */
function reportWeights(fit: SleeperFit): void {
  console.log(
    `\nwhat the ${fit.trainedOn[0]} to ` +
    `${fit.trainedOn[fit.trainedOn.length - 1]} fit weighs, in points a ` +
    "game per deviation",
  );
  console.log(`  intercept${" ".repeat(15)}${fit.weights[0]!.toFixed(2)}`);

  for (let i = 0; i < SLEEPER_TERMS.length; i++) {
    console.log(
      `  ${SLEEPER_TERMS[i]!.padEnd(24)}${fit.weights[i + 1]!.toFixed(2)}`,
    );
  }
}

/** the reasons behind one cut's top few, since a bare ranking is no use */
function reportReasons(
  season: number, week: number, picks: SleeperScore[],
): void {
  console.log(`\nwhat the model said in ${season} after week ${week}`);

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

/* ---------- putting the bench together ---------- */

interface Built {
  rows: Row[];
  /** the seasons a price curve could be fitted for */
  priced: number[];
  skipped: Map<number, string>;
}

async function build(seasons: number[]): Promise<Built> {
  const counted = await loadLeverage(seasons);
  const cache = new Map<number, SeasonPrices | null>();
  const rows: Row[] = [];
  const priced: number[] = [];
  const skipped = new Map<number, string>();

  for (const season of seasons) {
    const curve = await marketPriceAsOf(season, { counted: cache })
      .catch((error: Error) => error);

    if (curve instanceof Error) {
      skipped.set(season, "no price curve, too few earlier boards");
      continue;
    }

    const lines = counted.get(season) ?? [];

    if (lines.length === 0) {
      skipped.set(season, "nothing counted in the leverage file");
      continue;
    }

    const read = readSeason(await loadPlayerStats(season));
    const byName = boardByName(await loadAdp(season, "ppr"));
    priced.push(season);

    for (const week of CUTS) {
      rows.push(...cutsFor(season, week, read, curve, byName, lines));
    }
  }

  return { rows, priced, skipped };
}

const cheap = (row: Row) => !row.cut.drafted || row.cut.price > TOP_PRICED;

async function main(): Promise<void> {
  const seasons = seasonsAsked(process.argv, SEASONS);
  const { rows, priced, skipped } = await build(seasons);
  const examples: SleeperExample[] = rows.map((row) => ({
    cut: row.cut, restOfSeasonPpg: row.restOfSeasonPpg,
  }));
  const pooled = new Map(NAMES.map((name) => [name, emptyTally()]));
  const bySeason = new Map(
    NAMES.map((name) => [name, new Map<number, Tally>()]),
  );
  const scorable = priced.filter((season) => season > (priced[0] ?? Infinity));
  let last: { season: number; week: number; picks: SleeperScore[] } | undefined;

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
    const fit = fitSleepersAsOf(season, examples);

    for (const week of CUTS) {
      const population = rows.filter((row) =>
        row.cut.season === season && row.cut.week === week && cheap(row));
      const ranked = rankSleepers(fit, population.map((row) => row.cut));
      const scored = new Map(ranked.map((one) => [one.playerId, one]));

      for (const name of NAMES) {
        const picks = topPicks(population, METHODS[name]!, scored);
        tallied(pooled.get(name)!, picks);
        const seasons = bySeason.get(name)!;
        const tally = seasons.get(season) ?? emptyTally();
        tallied(tally, picks);
        seasons.set(season, tally);
      }

      last = { season, week, picks: ranked.slice(0, 5) };
    }
  }

  const fitted = fitSleepersAsOf(scorable[scorable.length - 1]!, examples);
  console.log(
    `weeks ${CUTS.join(", ")} of ${scorable[0]} to ` +
    `${scorable[scorable.length - 1]}, over the players priced past ` +
    `${TOP_PRICED} or undrafted, in PPR. Each method picks ${PICKS}.`,
  );
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

  reportPooled(pooled, bySeason);
  reportHeadToHead(bySeason, "the points a pick returned", perPick);
  reportHeadToHead(bySeason, "precision at 20", (tally) =>
    precision(tally, 20));
  reportWeights(fitted);

  if (last) {
    reportReasons(last.season, last.week, last.picks);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

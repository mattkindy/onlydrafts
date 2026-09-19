/**
 * What does the next man up actually inherit?
 *
 * `wouldAverage` hands a backup the whole of the job in front of him at
 * his own points per opportunity. This measures both halves of that. For
 * every player ranked 2 or 3 at his position at weeks 4, 6 and 8 of 2015
 * to 2025 who went on to play a starter's share of the snaps for three
 * weeks or more, it prints what share of the incumbent's opportunities
 * and points he got, by position and by what he already had. Then it asks
 * whether his rate before the cut says anything about his rate with the
 * job.
 *
 * Run: npx tsx scripts/inheritanceProbe.ts [--seasons 2015-2018]
 */

import {
  contingentSeasonFor, inheritanceIn, MIN_WEEKS_WITH_JOB,
  type Inherited,
} from "../src/backtest/contingentBench.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { seasonsAsked } from "../src/data/seasons.js";

const ALL_SEASONS = Array.from({ length: 11 }, (_, i) => 2015 + i);
const CUTS = [4, 6, 8];
const POSITIONS = ["QB", "RB", "WR", "TE"];

/** where a backup counts as already having a rotational share */
const ROTATIONAL = 0.2;

const quantile = (values: number[], at: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const place = at * (sorted.length - 1);
  const low = Math.floor(place);
  const high = Math.ceil(place);

  return sorted[low]! + (sorted[high]! - sorted[low]!) * (place - low);
};

const mean = (values: number[]) =>
  values.length === 0
    ? 0
    : values.reduce((sum, one) => sum + one, 0) / values.length;

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

/** the least squares line of was on said, for one reader against one outcome */
function slopeOf(said: number[], was: number[]): number {
  const middleSaid = mean(said);
  const middleWas = mean(was);
  const top = said.reduce(
    (sum, one, i) => sum + (one - middleSaid) * (was[i]! - middleWas), 0,
  );
  const bottom = said.reduce((sum, one) => sum + (one - middleSaid) ** 2, 0);

  return bottom === 0 ? 0 : top / bottom;
}

const oppShare = (one: Inherited) =>
  one.starterOpportunities === 0
    ? 0
    : one.opportunities / one.starterOpportunities;

const pointShare = (one: Inherited) =>
  one.starterPoints === 0 ? 0 : one.points / one.starterPoints;

function reportShares(
  title: string, rows: Inherited[], read: (one: Inherited) => number,
): void {
  console.log(`\n${title}`);
  console.log("  position    cases   lower   median   upper    mean");

  for (const position of [...POSITIONS, "all"]) {
    const mine = position === "all"
      ? rows
      : rows.filter((one) => one.position === position);
    const shares = mine.map(read);

    if (shares.length === 0) {
      continue;
    }

    console.log(
      `  ${position.padEnd(10)}${String(shares.length).padStart(5)}` +
      `   ${quantile(shares, 0.25).toFixed(3)}` +
      `    ${quantile(shares, 0.5).toFixed(3)}` +
      `   ${quantile(shares, 0.75).toFixed(3)}` +
      `   ${mean(shares).toFixed(3)}`,
    );
  }
}

/** the same split by whether he was already getting a fifth of the snaps */
function reportBySnapShare(rows: Inherited[]): void {
  console.log(
    "\nthe opportunity share by what he already had " +
    `(rotational is ${ROTATIONAL} of the snaps or more)`,
  );
  console.log("  position    who        cases   median    mean");

  for (const position of [...POSITIONS, "all"]) {
    for (const [who, keep] of [
      ["bench", (one: Inherited) => one.snapShareBefore < ROTATIONAL],
      ["rotational", (one: Inherited) => one.snapShareBefore >= ROTATIONAL],
    ] as const) {
      const mine = (position === "all"
        ? rows
        : rows.filter((one) => one.position === position)).filter(keep);

      if (mine.length === 0) {
        continue;
      }

      const shares = mine.map(oppShare);
      console.log(
        `  ${position.padEnd(10)}${who.padEnd(12)}` +
        `${String(shares.length).padStart(4)}` +
        `   ${quantile(shares, 0.5).toFixed(3)}   ${mean(shares).toFixed(3)}`,
      );
    }
  }
}

/** whether the share he got can be read off the share he already had */
function reportShareFit(rows: Inherited[]): void {
  console.log("\nthe opportunity share read off the snap share he already had");
  console.log("  position    cases   intercept   slope   correlation");

  for (const position of [...POSITIONS, "all"]) {
    const mine = position === "all"
      ? rows
      : rows.filter((one) => one.position === position);

    if (mine.length < 5) {
      continue;
    }

    const said = mine.map((one) => one.snapShareBefore);
    const was = mine.map(oppShare);
    const slope = slopeOf(said, was);

    console.log(
      `  ${position.padEnd(10)}${String(mine.length).padStart(5)}` +
      `   ${(mean(was) - slope * mean(said)).toFixed(3).padStart(9)}` +
      `   ${slope.toFixed(3).padStart(5)}` +
      `   ${correlation(said, was).toFixed(3).padStart(11)}`,
    );
  }
}

/**
 * The opportunities he got read off the size of the job rather than off
 * the share, since a share near one over a 28 touch workhorse and a share
 * near one over a 12 touch committee are not the same claim.
 */
function reportLevelFit(rows: Inherited[]): void {
  for (const [what, read] of [
    ["the man in front had", (one: Inherited) => one.starterOpportunities],
    ["he was getting himself", (one: Inherited) => one.ownOpportunities],
  ] as const) {
    console.log(`\nwhat he got a game read off what ${what}`);
    console.log(
      "  position    cases   intercept   slope   correlation   said   he got",
    );

    for (const position of [...POSITIONS, "all"]) {
      const mine = position === "all"
        ? rows
        : rows.filter((one) => one.position === position);

      if (mine.length < 5) {
        continue;
      }

      const said = mine.map(read);
      const was = mine.map((one) => one.opportunities);
      const slope = slopeOf(said, was);

      console.log(
        `  ${position.padEnd(10)}${String(mine.length).padStart(5)}` +
        `   ${(mean(was) - slope * mean(said)).toFixed(2).padStart(9)}` +
        `   ${slope.toFixed(3).padStart(5)}` +
        `   ${correlation(said, was).toFixed(3).padStart(11)}` +
        `   ${mean(said).toFixed(1).padStart(4)}   ${mean(was).toFixed(1)}`,
      );
    }
  }
}

/**
 * The two readers together, which is the line the model would use: what
 * he got a game off the size of the job and off his own work, per
 * position, with a mean absolute error to say how much either buys.
 */
function reportInheritanceLine(rows: Inherited[]): void {
  console.log("\nboth together, as the line a model would carry");
  console.log(
    "  position    cases    base   from the job   from his own work" +
    "   error   error off the base alone",
  );

  for (const position of POSITIONS) {
    const mine = rows.filter((one) => one.position === position);

    if (mine.length < 5) {
      continue;
    }

    const X = mine.map((one) =>
      [1, one.starterOpportunities, one.ownOpportunities]);
    const y = mine.map((one) => one.opportunities);
    const weights = fitRidge(X, y, 1e-6);
    const off = (said: (i: number) => number) =>
      mean(y.map((was, i) => Math.abs(said(i) - was)));

    console.log(
      `  ${position.padEnd(10)}${String(mine.length).padStart(5)}` +
      `  ${weights[0]!.toFixed(2).padStart(6)}` +
      `   ${weights[1]!.toFixed(3).padStart(12)}` +
      `   ${weights[2]!.toFixed(3).padStart(17)}` +
      `   ${off((i) => predictRidge(weights, X[i]!)).toFixed(2).padStart(5)}` +
      `   ${off(() => mean(y)).toFixed(2).padStart(23)}`,
    );
  }
}

/**
 * Whether a backup's points an opportunity on few touches says anything
 * about his points an opportunity with the job. A slope near one means
 * he scores at the same rate with the job and a slope near nought means
 * his rate with the job should be
 * read off his position instead.
 */
function reportEfficiency(rows: Inherited[]): void {
  const read = rows.filter((one) => one.rateBefore !== undefined);
  console.log(
    "\nhis rate with the job against his rate before it, over the " +
    `${read.length} who had enough touches to read one`,
  );
  console.log(
    "  position    cases   slope   correlation   his mean   with the job" +
    "   touches   the shrink that slope asks for",
  );

  for (const position of [...POSITIONS, "all"]) {
    const mine = position === "all"
      ? read
      : read.filter((one) => one.position === position);

    if (mine.length < 5) {
      continue;
    }

    const said = mine.map((one) => one.rateBefore! - one.positionRate);
    const was = mine.map((one) => one.rateWithJob - one.positionRate);
    const slope = slopeOf(said, was);
    const touches = mean(mine.map((one) => one.opportunitiesBefore));

    console.log(
      `  ${position.padEnd(10)}${String(mine.length).padStart(5)}` +
      `   ${slope.toFixed(3).padStart(5)}` +
      `   ${correlation(said, was).toFixed(3).padStart(11)}` +
      `   ${mean(mine.map((one) => one.rateBefore!)).toFixed(3).padStart(8)}` +
      `   ${mean(mine.map((one) => one.rateWithJob)).toFixed(3).padStart(12)}` +
      `   ${touches.toFixed(0).padStart(7)}` +
      `   ${(slope <= 0 ? Infinity : touches * (1 - slope) / slope)
        .toFixed(0).padStart(30)}`,
    );
  }
}

/** the cases a reader knows by name, so the numbers can be checked by eye */
const NAMED = [
  "Jeremy McNichols", "Alexander Mattison", "Tony Pollard", "Jaylen Warren",
  "Gus Edwards", "Jordan Mason", "Kyren Williams", "Puka Nacua",
  "Tyler Boyd", "Justice Hill", "Latavius Murray", "Rico Dowdle",
];

function reportNamed(rows: Inherited[]): void {
  console.log("\nsome cases by name");

  for (const one of rows.filter((row) => NAMED.includes(row.playerName))) {
    console.log(
      `  ${one.playerName.padEnd(20)} ${one.position} ${one.season} ` +
      `wk${String(one.week).padStart(2)}  the man in front had ` +
      `${one.starterOpportunities.toFixed(1)} a game, he got ` +
      `${one.opportunities.toFixed(1)} over ${one.weeksWithJob} weeks ` +
      `(${(oppShare(one) * 100).toFixed(0)}%), ` +
      `${one.points.toFixed(1)} points a game`,
    );
  }
}

async function main(): Promise<void> {
  const seasons = seasonsAsked(process.argv, ALL_SEASONS);
  const rows: Inherited[] = [];

  for (const season of seasons) {
    const input = await contingentSeasonFor(season, new Map());
    rows.push(...inheritanceIn(input, CUTS));
  }

  console.log(
    `weeks ${CUTS.join(", ")} of ${seasons[0]} to ` +
    `${seasons[seasons.length - 1]}: ${rows.length} players ranked 2 or 3 ` +
    "at their position went on to play a starter's share for " +
    `${MIN_WEEKS_WITH_JOB} weeks or more.`,
  );

  reportShares(
    "what share of the man in front's opportunities a game he got", rows,
    oppShare,
  );
  reportShares("and what share of his points a game", rows, pointShare);
  reportBySnapShare(rows);
  reportShareFit(rows);
  reportLevelFit(rows);
  reportInheritanceLine(rows);
  reportEfficiency(rows);
  reportNamed(rows);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

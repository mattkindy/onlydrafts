/**
 * The rows the expected points score is built and marked on.
 *
 * Two things it needs that no other bench keeps. The first is the chance
 * the man in front misses a week, which comes off the availability model
 * the season sim already ships and is not refitted here. The second is
 * every incumbent and backup pair at a cut, with whether the backup had
 * the job four weeks later while the incumbent was fit and playing, which
 * is what a benching looks like from a stat file.
 */

import { loadAdp } from "../data/adp.js";
import { loadPlayerStats, loadSnapCounts } from "../data/nflverse.js";
import { fitAbsence } from "../features/fitAbsence.js";
import {
  fitAvailability, predictAvailability,
} from "../features/gamesPlayed.js";
import { readAvailability } from "../features/availabilityData.js";
import {
  marketPriceAsOf, type SeasonPrices,
} from "../features/marketPrice.js";
import {
  fitBenchingAsOf,
  type BenchCut, type BenchExample, type BenchFit,
} from "../model/expectedSleepers.js";
import { UNDRAFTED_PRICE } from "../model/sleepers.js";
import { boardByName, pricedAs, type Row } from "./sleeperBench.js";
import {
  MEANINGFUL_PER_GAME, peckingOrders, readOpportunities, rosterFactsFor,
  listedWeeksFor, snapsById, STARTER_SNAPS,
  type OpportunitySeason, type RosterFacts,
} from "./contingentBench.js";

/* ---------- how often the man in front misses a week ---------- */

/**
 * The games a player with no season behind him is read at. A rookie has
 * nothing for the availability model to read, and the sim's own season
 * walk gives him the same fifteen.
 */
const GAMES_WITHOUT_A_HISTORY = 15;

const GAMES_IN_SEASON = 17;

/** the earliest season the availability model has the files to be fitted on */
const FIRST_AVAILABLE_SEASON = 2018;

/** how many seasons of played weeks the absence spells are drawn from */
const ABSENCE_SEASONS = 4;

/** the walls a weekly miss chance is kept inside */
const LOWEST_MISS = 0.01;
const HIGHEST_MISS = 0.6;

export interface MissWorld {
  /** the chance this player misses any one week of `season` */
  missPerWeek: (season: number, playerId: string, position: string) => number;
}

/**
 * The season sim's answer to "how many games will he play", turned into a
 * weekly chance.
 *
 * The sim draws a player down at a hazard and keeps him down for a spell,
 * so over a long run the share of weeks he is down is the hazard times
 * the spell length against one plus the same product. That share is what
 * a backup behind him wants to know. The fit for a season reads only the
 * seasons before it.
 */
export async function missWorldFor(seasons: number[]): Promise<MissWorld> {
  const scored = seasons.filter((one) => one > FIRST_AVAILABLE_SEASON);
  const cached = new Map<number, Awaited<ReturnType<typeof loadPlayerStats>>>();
  const load = async (year: number) => {
    if (!cached.has(year)) {
      cached.set(year, await loadPlayerStats(year).catch(() => []));
    }

    return cached.get(year)!;
  };
  const availability = await readAvailability(
    seasons.filter((one) => one >= FIRST_AVAILABLE_SEASON),
  );
  const expected = new Map<number, Map<string, number>>();
  const hazards = new Map<number, Awaited<ReturnType<typeof fitAbsence>>>();

  for (const season of scored) {
    const fit = fitAvailability(
      Array.from(
        { length: season - FIRST_AVAILABLE_SEASON },
        (_, i) => FIRST_AVAILABLE_SEASON + i,
      ).flatMap((year) => availability.rowsFor(year)),
    );
    const his = new Map<string, number>();

    for (const row of availability.rowsFor(season)) {
      his.set(row.playerId, predictAvailability(fit, row));
    }

    expected.set(season, his);
    hazards.set(season, await fitAbsence(
      Array.from({ length: ABSENCE_SEASONS }, (_, i) => season - 1 - i),
      load,
    ));
  }

  return {
    missPerWeek: (season, playerId, position) => {
      const absence = hazards.get(season);

      if (!absence) {
        return LOWEST_MISS;
      }

      const games = expected.get(season)?.get(playerId)
        ?? GAMES_WITHOUT_A_HISTORY;
      const down = absence.hazardFor(position, games, GAMES_IN_SEASON)
        * absence.meanSpellOf(position);

      return Math.min(HIGHEST_MISS, Math.max(LOWEST_MISS, down / (1 + down)));
    },
  };
}

/* ---------- who lost a job without getting hurt ---------- */

/** everything the benching question reads about one season */
export interface BenchingSeason {
  read: OpportunitySeason;
  snaps: Map<string, Map<number, number>>;
  roster: RosterFacts;
  /** the weeks each player was on the injury report */
  listed: Map<string, Set<number>>;
}

export async function benchingSeasonFor(
  season: number,
): Promise<BenchingSeason> {
  const read = readOpportunities(
    season, await loadPlayerStats(season).catch(() => []),
  );

  return {
    read,
    snaps: snapsById(read, await loadSnapCounts(season).catch(() => [])),
    roster: await rosterFactsFor(season),
    listed: await listedWeeksFor(season),
  };
}

/** one incumbent and one backup at one cut, and how the next month went */
export interface BenchingCase {
  season: number;
  week: number;
  position: string;
  starterId: string;
  playerId: string;
  cut: BenchCut;
  /**
   * Whether the incumbent's price was knowable that season. The curve
   * wants three earlier boards, so the seasons before 2018 have the
   * outcome and no starter gap, and they count toward the rate without
   * being fitted on.
   */
  priced: boolean;
  /**
   * The backup had the job four weeks on with the incumbent fit and
   * playing. Absent when the club had fewer than four games left.
   */
  benched?: boolean;
  /** club weeks after the cut the man in front did not play */
  starterMissedAfter: number;
  /** weeks after the cut the job was open: the man in front missed it,
   * or the backup was taking a starter's share himself */
  openWeeks: number;
  /** the backup's points over those weeks, a week he did not play as nothing */
  pointsWhenOpen: number;
  /** he took a starter's share of the snaps over the weeks he played after */
  tookStartersShare: boolean;
}

/** the backups a job could come to, by where they rank at the cut */
const BEHIND = [2, 3];

/** how many weeks on a benching is read */
const HORIZON = 4;

/** how many of those four weeks the incumbent has to be fit for */
const WEEKS_FIT = 3;

/** the weeks of snap share a trend is read over, the cut week included */
const TREND_WEEKS = 3;

/** the pick inside which a club has paid for a player to play */
const HIGH_CAPITAL_PICK = 100;

/** the seasons in the league a player is still a recent pick for */
const YOUNG = 1;

/** what a player scored and how many of the weeks he played */
const pointsOver = (
  read: OpportunitySeason, playerId: string, weeks: Iterable<number>,
): { points: number; games: number } => {
  const his = read.weeks.get(playerId);
  let points = 0;
  let games = 0;

  for (const week of weeks) {
    const did = his?.get(week);

    if (did) {
      points += did.points;
      games++;
    }
  }

  return { points, games };
};

const opportunitiesOver = (
  read: OpportunitySeason, playerId: string, weeks: number[],
): number => {
  const his = read.weeks.get(playerId);

  return weeks.reduce(
    (sum, week) => sum + (his?.get(week)?.opportunities ?? 0), 0,
  );
};

/** how far his share of the snaps moved over the last three weeks */
function snapTrendOf(
  snaps: Map<string, Map<number, number>>, playerId: string, week: number,
): number {
  const his = snaps.get(playerId);
  const read: { week: number; share: number }[] = [];

  for (let one = week - TREND_WEEKS + 1; one <= week; one++) {
    const share = his?.get(one);

    if (share !== undefined && share > 0) {
      read.push({ week: one, share });
    }
  }

  if (read.length < 2) {
    return 0;
  }

  return read[read.length - 1]!.share - read[0]!.share;
}

/** what the board said a player at his price averages, when it is knowable */
export type PriceOf = (playerId: string, position: string) => number | undefined;

/**
 * Every incumbent and backup pair at every cut of one season.
 *
 * A benching is read off the work rather than off the depth chart: over
 * the four weeks after the cut the backup got more opportunity than the
 * man in front, while the man in front dressed for at least three of them
 * and was active and off the injury report in the last of them. A club
 * that has moved on from a fit starter looks exactly like that, and an
 * injury does not.
 */
export function benchingIn(
  season: BenchingSeason, cuts: number[], priceOf?: PriceOf,
): BenchingCase[] {
  const { read, snaps, roster, listed } = season;
  const out: BenchingCase[] = [];

  for (const week of cuts) {
    for (const [key, order] of peckingOrders(read, week)) {
      const [club = "", position = ""] = key.split("|");
      const top = order[0];

      if (!top || top.perGame < MEANINGFUL_PER_GAME) {
        continue;
      }

      const played = [...(read.clubWeeks.get(club) ?? [])]
        .sort((a, b) => a - b);
      const before = played.filter((one) => one <= week);
      const after = played.filter((one) => one > week);
      const window = after.slice(0, HORIZON);
      const starter = pointsOver(read, top.playerId, before);
      const starterPrice = priceOf?.(top.playerId, position);
      /**
       * Fit means the roster file has him active and the injury report
       * has nothing on him. A club that benches a quarterback still
       * dresses him, so reading this off the weeks he played would throw
       * away the cases the question is about.
       */
      const fitIn = window.filter((one) =>
        (roster.activeWeeks.get(top.playerId)?.has(one) ?? false)
          && !(listed.get(top.playerId)?.has(one) ?? false));
      const lastOfWindow = window[window.length - 1];
      const known = window.length === HORIZON
        && fitIn.length >= WEEKS_FIT
        && lastOfWindow !== undefined && fitIn.includes(lastOfWindow);
      const starterWork = opportunitiesOver(read, top.playerId, window);
      const starterMissed = after
        .filter((one) => !read.weeks.get(top.playerId)?.has(one)).length;

      for (const place of BEHIND) {
        const his = order[place - 1];

        if (!his) {
          continue;
        }

        const work = opportunitiesOver(read, his.playerId, window);
        const open = after.filter((one) =>
          !read.weeks.get(top.playerId)?.has(one)
            || (snaps.get(his.playerId)?.get(one) ?? 0) >= STARTER_SNAPS);
        const shares = after
          .map((one) => snaps.get(his.playerId)?.get(one))
          .filter((one): one is number => one !== undefined && one > 0);
        const pick = roster.draftOverall.get(his.playerId);
        const years = roster.experience.get(his.playerId);

        out.push({
          season: read.season,
          week,
          position,
          starterId: top.playerId,
          playerId: his.playerId,
          cut: {
            position,
            starterGap: starterPrice === undefined || starter.games === 0
              ? 0
              : starter.points / starter.games - starterPrice,
            backupCapital: pick !== undefined && pick <= HIGH_CAPITAL_PICK
              && years !== undefined && years <= YOUNG,
            snapTrend: snapTrendOf(snaps, his.playerId, week),
          },
          priced: starterPrice !== undefined,
          benched: known
            ? work > starterWork && work >= MEANINGFUL_PER_GAME * HORIZON
            : undefined,
          starterMissedAfter: starterMissed,
          openWeeks: open.length,
          pointsWhenOpen: pointsOver(read, his.playerId, open).points,
          tookStartersShare: shares.length > 0
            && shares.reduce((a, b) => a + b, 0) / shares.length
              >= STARTER_SNAPS,
        });
      }
    }
  }

  return out;
}

/** the key one case is filed under, since a backup has one man in front */
export const benchingKey = (
  season: number, week: number, playerId: string,
): string => `${season}|${week}|${playerId}`;

/**
 * Every pair of one season at the cuts asked for, with the price side
 * filled in when a curve can be fitted for that season and left out when
 * it cannot.
 */
export async function benchingFor(
  season: number, cuts: number[],
  cache = new Map<number, SeasonPrices | null>(),
): Promise<BenchingCase[]> {
  const input = await benchingSeasonFor(season);
  const curve = await marketPriceAsOf(season, { counted: cache })
    .catch(() => undefined);
  const byName = boardByName(
    await loadAdp(season, "ppr").catch(() => new Map()),
  );
  const priceOf: PriceOf | undefined = curve === undefined
    ? undefined
    : (playerId, position) => {
      const entry = pricedAs(
        byName, input.read.names.get(playerId) ?? "", position,
      );

      return curve.quantiles(position, entry?.adp ?? UNDRAFTED_PRICE).p50;
    };

  return benchingIn(input, cuts, priceOf);
}

/** the same over a run of seasons, oldest first */
export async function buildBenching(
  seasons: number[], cuts: number[],
): Promise<BenchingCase[]> {
  const cache = new Map<number, SeasonPrices | null>();
  const out: BenchingCase[] = [];

  for (const season of [...seasons].sort((a, b) => a - b)) {
    out.push(...await benchingFor(season, cuts, cache));
  }

  return out;
}

/** the cases keyed the way a bench row looks one up */
export const benchingBy = (
  cases: BenchingCase[],
): Map<string, BenchingCase> => new Map(cases.map((one) =>
  [benchingKey(one.season, one.week, one.playerId), one]));

/**
 * The benching fit for each season, as a reader could have had it before
 * that season kicked off.
 *
 * The earliest priced season has no earlier pairs behind it and reads the
 * fit from the season after. Its rows only ever teach a later season's
 * sleeper fit, so nothing being scored is read by a fit that saw the
 * season it is scoring.
 */
export function benchFits(
  priced: number[], teaching: BenchExample[],
): (season: number) => BenchFit | undefined {
  const ordered = [...priced].sort((a, b) => a - b);
  const earliest = ordered[1];
  const fits = new Map<number, BenchFit>();

  return (season) => {
    if (earliest === undefined) {
      return undefined;
    }

    const asOf = Math.max(season, earliest);

    if (!fits.has(asOf)) {
      fits.set(asOf, fitBenchingAsOf(asOf, teaching));
    }

    return fits.get(asOf);
  };
}

/**
 * Puts what the benching sweep knows about a pair onto the bench row for
 * the backup, so the sleeper fit can read the same three features and the
 * chance they add up to without building any of them again.
 *
 * A row with no pair keeps its zeros, which is every player who is not
 * ranked second or third at his position.
 */
export function fillBenchingTerms(
  rows: Row[],
  cases: Map<string, BenchingCase>,
  chanceOf: (season: number, cut: BenchCut) => number,
): void {
  for (const row of rows) {
    const { season, week, playerId } = row.cut;
    const his = cases.get(benchingKey(season, week, playerId));

    if (!his) {
      continue;
    }

    row.cut.starterGap = his.cut.starterGap;
    row.cut.backupCapital = his.cut.backupCapital;
    row.cut.snapTrend = his.cut.snapTrend;
    row.cut.benchedChance = chanceOf(season, his.cut);
  }
}

/** the cases a fit can be taught on: priced, and with the four weeks played */
export const benchExamples = (cases: BenchingCase[]): BenchExample[] =>
  cases
    .filter((one) => one.priced && one.benched !== undefined)
    .map((one) => ({
      cut: one.cut, season: one.season, benched: one.benched!,
    }));

/**
 * The rows the contingent sleeper score is built and marked on.
 *
 * `sleeperBench.ts` already says who was cheap at a cut and what he went
 * on to score. This adds the three things that score needs and that one
 * does not keep: what each player has done per opportunity, how big the
 * job in front of him is, and whether that job came to him afterwards.
 *
 * A player's rank at his position is taken off the work his club has
 * actually handed out this season rather than off the published chart.
 * The chart changes shape in 2025 and lags a club by a week or two
 * either way, and the question here is who is getting the ball.
 */

import { loadCompromisedWeeks } from "../data/injuries.js";
import { normalizeName } from "../data/names.js";
import {
  loadPlayerStats, loadSnapCounts, loadWeeklyRosters,
  type PlayerWeekStats, type SnapCountWeek,
} from "../data/nflverse.js";
import { PRICED_POSITIONS } from "../features/marketPrice.js";
import type { ContingentCut, RoleExample } from "../model/contingentSleepers.js";
import { fantasyPoints, scoringRules } from "../scoring/fantasyPoints.js";
import type { Row } from "./sleeperBench.js";

const RULES = scoringRules("ppr");
const LAST_WEEK = 18;

/** where a starter's share of the snaps begins */
export const STARTER_SNAPS = 0.5;

/**
 * How many weeks a player has to be on the field after the cut before
 * his share is read. One appearance at 60% in a blowout is not a job.
 */
export const MIN_WEEKS_ON_FIELD = 2;

/** how many of the remaining weeks a starter misses before the job is open */
const MISSED_TO_OPEN = 3;

/**
 * A quarterback throws and everybody else catches or runs, so the count
 * that measures a job is not the same count at every position. Both are
 * chances to score with the ball, which is what the efficiency divides.
 */
const opportunitiesIn = (week: PlayerWeekStats): number =>
  week.position === "QB"
    ? week.passing.attempts + week.carries
    : week.targets + week.carries;

/* ---------- one season, read once ---------- */

/** what one player did in one week, reduced to the two numbers needed */
interface Did {
  opportunities: number;
  points: number;
}

const nothing = (): Did => ({ opportunities: 0, points: 0 });

const add = (into: Did, more: Did): void => {
  into.opportunities += more.opportunities;
  into.points += more.points;
};

/** everything one season's stat file says about opportunity, by player */
export interface OpportunitySeason {
  season: number;
  /** his week by week work, so any cut week can be summed out of it */
  weeks: Map<string, Map<number, Did>>;
  positions: Map<string, string>;
  /** the stat file's own spelling, which the snap count join needs */
  names: Map<string, string>;
  /** the club he appeared for each week */
  clubBy: Map<string, Map<number, string>>;
  /** the weeks each club played */
  clubWeeks: Map<string, Set<number>>;
}

export function readOpportunities(
  season: number, stats: PlayerWeekStats[],
): OpportunitySeason {
  const read: OpportunitySeason = {
    season,
    weeks: new Map(), positions: new Map(), names: new Map(),
    clubBy: new Map(), clubWeeks: new Map(),
  };

  for (const week of stats) {
    if (week.position) {
      read.positions.set(week.playerId, week.position);
    }

    read.names.set(week.playerId, week.playerName);

    const his = read.weeks.get(week.playerId) ?? new Map<number, Did>();
    his.set(week.week, {
      opportunities: opportunitiesIn(week),
      points: fantasyPoints(week.statLine, RULES),
    });
    read.weeks.set(week.playerId, his);

    const clubs = read.clubBy.get(week.playerId) ?? new Map<number, string>();
    clubs.set(week.week, week.teamId);
    read.clubBy.set(week.playerId, clubs);

    const played = read.clubWeeks.get(week.teamId) ?? new Set<number>();
    played.add(week.week);
    read.clubWeeks.set(week.teamId, played);
  }

  return read;
}

/** his work over a stretch of weeks, and how many of them he played */
function totalled(
  read: OpportunitySeason, playerId: string, from: number, to: number,
): Did & { games: number } {
  const summed = { ...nothing(), games: 0 };

  for (const [week, did] of read.weeks.get(playerId) ?? []) {
    if (week < from || week > to) {
      continue;
    }

    add(summed, did);
    summed.games++;
  }

  return summed;
}

/* ---------- who is in front of whom ---------- */

/** one club's players at one position, the busiest first */
interface Pecking {
  playerId: string;
  perGame: number;
  opportunities: number;
}

/**
 * The opportunity each club hands out at each position through the cut,
 * ranked. A club that has played four games and given its lead back
 * fourteen carries a game is offering a job worth fourteen carries.
 */
function peckingOrders(
  read: OpportunitySeason, week: number,
): Map<string, Pecking[]> {
  const byClub = new Map<string, Map<string, Pecking>>();

  for (const [playerId, position] of read.positions) {
    if (!PRICED_POSITIONS.includes(position)) {
      continue;
    }

    const club = clubAt(read, playerId, week);

    if (!club) {
      continue;
    }

    const his = totalled(read, playerId, 1, week);
    const games = [...(read.clubWeeks.get(club) ?? [])]
      .filter((one) => one <= week).length;
    const key = `${club}|${position}`;
    const mine = byClub.get(key) ?? new Map<string, Pecking>();

    mine.set(playerId, {
      playerId,
      perGame: games === 0 ? 0 : his.opportunities / games,
      opportunities: his.opportunities,
    });
    byClub.set(key, mine);
  }

  return new Map([...byClub].map(([key, mine]) => [
    key,
    [...mine.values()].sort((a, b) => b.perGame - a.perGame),
  ]));
}

/** the club he last appeared for on or before the cut */
function clubAt(
  read: OpportunitySeason, playerId: string, week: number,
): string {
  const clubs = read.clubBy.get(playerId);

  for (let earlier = week; earlier >= 1; earlier--) {
    const club = clubs?.get(earlier);

    if (club) {
      return club;
    }
  }

  return "";
}

/** a teammate below this is not taking work off anybody */
const MEANINGFUL_PER_GAME = 3;

/* ---------- the snaps ---------- */

/**
 * Snap counts come keyed by the name Pro Football Reference writes and
 * everything else here is keyed by a gsis id, so the join is on a
 * normalized name inside a club. A name that matches two players on one
 * club is dropped rather than guessed at.
 */
function snapsById(
  read: OpportunitySeason, counts: SnapCountWeek[],
): Map<string, Map<number, number>> {
  const byKey = new Map<string, string | null>();

  for (const [playerId] of read.positions) {
    const name = normalizeName(read.names.get(playerId) ?? "");

    for (const club of new Set((read.clubBy.get(playerId) ?? []).values())) {
      const key = `${club}|${name}`;
      const already = byKey.get(key);

      byKey.set(key, already !== undefined && already !== playerId
        ? null
        : playerId);
    }
  }

  const found = new Map<string, Map<number, number>>();

  for (const count of counts) {
    const playerId = byKey
      .get(`${count.teamId}|${normalizeName(count.playerName)}`);

    if (!playerId) {
      continue;
    }

    const his = found.get(playerId) ?? new Map<number, number>();
    his.set(count.week, count.offensePct);
    found.set(playerId, his);
  }

  return found;
}

/**
 * His mean share of his club's offensive snaps over a stretch of weeks.
 * The release writes the share as a fraction already, so it comes back
 * the same way rather than as a percentage.
 */
function snapShareOver(
  snaps: Map<string, Map<number, number>>,
  playerId: string, from: number, to: number,
): { share: number; weeks: number } {
  let total = 0;
  let weeks = 0;

  for (const [week, pct] of snaps.get(playerId) ?? []) {
    if (week < from || week > to || pct <= 0) {
      continue;
    }

    total += pct;
    weeks++;
  }

  return { share: weeks === 0 ? 0 : total / weeks, weeks };
}

/* ---------- who the man in front is ---------- */

/** what a club's roster files say about a player, over several seasons */
export interface RosterFacts {
  age: Map<string, number>;
  draftOverall: Map<string, number>;
  /** seasons in the league, as the roster file counts them */
  experience: Map<string, number>;
  /** the weeks the file marked him active, so the rest are weeks he was not */
  activeWeeks: Map<string, Set<number>>;
}

const SEASON_START = "-09-01";

/** the roster file's word for a player who can be picked to play */
const ACTIVE = "ACT";

export async function rosterFactsFor(season: number): Promise<RosterFacts> {
  const age = new Map<string, number>();
  const draftOverall = new Map<string, number>();
  const experience = new Map<string, number>();
  const activeWeeks = new Map<string, Set<number>>();

  for (const row of await loadWeeklyRosters(season).catch(() => [])) {
    if (row.draftOverall !== undefined) {
      draftOverall.set(row.playerId, row.draftOverall);
    }

    if (row.yearsExperience !== undefined) {
      experience.set(row.playerId, row.yearsExperience);
    }

    if (row.status === ACTIVE) {
      const weeks = activeWeeks.get(row.playerId) ?? new Set<number>();
      weeks.add(row.week);
      activeWeeks.set(row.playerId, weeks);
    }

    if (row.birthDate) {
      const years = (Date.parse(`${season}${SEASON_START}`)
        - Date.parse(row.birthDate)) / (365.25 * 24 * 3600 * 1000);

      if (Number.isFinite(years) && years > 15 && years < 50) {
        age.set(row.playerId, years);
      }
    }
  }

  return { age, draftOverall, experience, activeWeeks };
}

/**
 * The weeks each player was on his club's injury report, by the same
 * reading `loadCompromisedWeeks` uses: limited or worse in practice, or
 * questionable or worse on the game report. A starter who has been on it
 * three weeks running is a job that may be about to open, which games
 * missed over the last two seasons cannot say.
 */
export async function listedWeeksFor(
  season: number,
): Promise<Map<string, Set<number>>> {
  const listed = new Map<string, Set<number>>();

  for (const key of await loadCompromisedWeeks(season)) {
    const [playerId, week] = key.split("|");

    if (!playerId || !week) {
      continue;
    }

    const weeks = listed.get(playerId) ?? new Set<number>();
    weeks.add(Number(week));
    listed.set(playerId, weeks);
  }

  return listed;
}

/**
 * Games a player's club played that he did not, over the two seasons
 * before this one. A stat file has no row for a player who did not dress,
 * so a missing week on a club that played is a week he missed.
 */
function gamesMissedBefore(
  playerId: string, before: OpportunitySeason[],
): number {
  let missed = 0;

  for (const read of before) {
    const club = clubAt(read, playerId, LAST_WEEK);

    if (!club) {
      continue;
    }

    const his = totalled(read, playerId, 1, LAST_WEEK);
    missed += Math.max(
      0, (read.clubWeeks.get(club)?.size ?? 0) - his.games,
    );
  }

  return missed;
}

/* ---------- the position base rate ---------- */

/**
 * How often the man doing a job at each position stopped doing it. For
 * every club and position at every cut of a season, the busiest player
 * through the cut either played most of the weeks left or he did not, and
 * the share who did not is the rate. A season reads only seasons before
 * it, so the rate a cut is scored with was knowable at the time.
 */
export function openRatesIn(
  read: OpportunitySeason, cuts: number[],
): Map<string, { open: number; of: number }> {
  const tally = new Map<string, { open: number; of: number }>();

  for (const week of cuts) {
    for (const [key, order] of peckingOrders(read, week)) {
      const position = key.split("|")[1] ?? "";
      const top = order[0];

      if (!top || top.perGame < MEANINGFUL_PER_GAME) {
        continue;
      }

      const club = key.split("|")[0] ?? "";
      const left = [...(read.clubWeeks.get(club) ?? [])]
        .filter((one) => one > week).length;
      const after = totalled(read, top.playerId, week + 1, LAST_WEEK);
      const mine = tally.get(position) ?? { open: 0, of: 0 };

      mine.of++;

      if (left - after.games >= MISSED_TO_OPEN) {
        mine.open++;
      }

      tally.set(position, mine);
    }
  }

  return tally;
}

/** the rate each position ran at over a set of seasons, pooled */
export const pooledOpenRate = (
  tallies: Map<string, { open: number; of: number }>[],
): Map<string, number> => {
  const summed = new Map<string, { open: number; of: number }>();

  for (const tally of tallies) {
    for (const [position, mine] of tally) {
      const already = summed.get(position) ?? { open: 0, of: 0 };

      summed.set(position, {
        open: already.open + mine.open, of: already.of + mine.of,
      });
    }
  }

  return new Map([...summed].map(([position, mine]) =>
    [position, mine.of === 0 ? 0 : mine.open / mine.of]));
};

/* ---------- putting one season's contingent rows together ---------- */

/** one cut, the contingent features on it, and whether the job opened */
export interface ContingentRow extends RoleExample {
  /** the bench row it was built from, for the points outcomes */
  row: Row;
  /** his share of the snaps over the weeks he was on the field after */
  snapShareAfter: number;
  weeksOnField: number;
}

/** everything one season needs before its contingent cuts can be built */
export interface ContingentSeason {
  read: OpportunitySeason;
  /** last season's, for the players whose own rate is thin this year */
  before?: OpportunitySeason;
  /** the two seasons before this one, for what the starter has missed */
  missedFrom: OpportunitySeason[];
  snaps: Map<string, Map<number, number>>;
  roster: RosterFacts;
  /** the weeks each player was on the injury report this season */
  listed: Map<string, Set<number>>;
  openRate: Map<string, number>;
}

/** what an opportunity pays at each position, pooled over the league */
function positionRates(
  read: OpportunitySeason, before: OpportunitySeason | undefined, week: number,
): Map<string, number> {
  const tally = new Map<string, Did>();

  const fold = (
    from: OpportunitySeason, to: number,
  ) => {
    for (const [playerId, position] of from.positions) {
      if (!PRICED_POSITIONS.includes(position)) {
        continue;
      }

      const mine = tally.get(position) ?? nothing();
      add(mine, totalled(from, playerId, 1, to));
      tally.set(position, mine);
    }
  };

  fold(read, week);

  if (before) {
    fold(before, LAST_WEEK);
  }

  return new Map([...tally].map(([position, did]) =>
    [position, did.opportunities === 0 ? 0 : did.points / did.opportunities]));
}

export function contingentRows(
  season: ContingentSeason, rows: Row[], week: number,
): ContingentRow[] {
  const { read, before, snaps, roster, listed } = season;
  const orders = peckingOrders(read, week);
  const rates = positionRates(read, before, week);
  const out: ContingentRow[] = [];

  for (const row of rows) {
    const { playerId, position } = row.cut;
    const order = orders.get(`${row.club}|${position}`) ?? [];
    const place = order.findIndex((one) => one.playerId === playerId);
    const top = order[0];

    if (place < 0 || !top) {
      continue;
    }

    const starterListed = listed.get(top.playerId) ?? new Set<number>();
    const games = [...(read.clubWeeks.get(row.club) ?? [])]
      .filter((one) => one <= week).length;
    const mine = totalled(read, playerId, 1, week);
    const last = season.before
      ? totalled(season.before, playerId, 1, LAST_WEEK)
      : { ...nothing(), games: 0 };
    const beforeCut = snapShareOver(snaps, playerId, 1, week);
    const afterCut = snapShareOver(snaps, playerId, week + 1, LAST_WEEK);
    const cut: ContingentCut = {
      season: row.cut.season,
      week,
      playerId,
      playerName: row.cut.playerName,
      position,
      club: row.club,
      price: row.cut.price,
      drafted: row.cut.drafted,
      priceMedian: row.cut.priceMedian,
      opportunities: mine.opportunities,
      ownOpportunities: games === 0 ? 0 : mine.opportunities / games,
      opportunityPoints: mine.points,
      lastOpportunities: last.opportunities,
      lastOpportunityPoints: last.points,
      positionPerOpportunity: rates.get(position) ?? 0,
      draftOverall: roster.draftOverall.get(playerId),
      age: roster.age.get(playerId),
      starterOpportunities: top.perGame,
      depthRank: place + 1,
      playersAhead: order
        .filter((one, i) => i < place && one.perGame >= MEANINGFUL_PER_GAME)
        .length,
      snapShare: beforeCut.share,
      starterAge: roster.age.get(top.playerId),
      starterGamesMissed: gamesMissedBefore(top.playerId, season.missedFrom),
      starterListedWeeks: [...starterListed].filter((one) => one <= week).length,
      starterListedNow: starterListed.has(week),
      starterOffRoster: !(roster.activeWeeks.get(top.playerId)?.has(week)
        ?? false),
      starterExperience: roster.experience.get(top.playerId),
      positionOpenRate: season.openRate.get(position) ?? 0,
      weeksLeft: row.weeksLeft,
    };

    out.push({
      cut,
      row,
      becameStarter: afterCut.weeks >= MIN_WEEKS_ON_FIELD
        && afterCut.share >= STARTER_SNAPS,
      snapShareAfter: afterCut.share,
      weeksOnField: afterCut.weeks,
    });
  }

  return out;
}

/* ---------- what the next man up actually got ---------- */

/**
 * How many weeks a backup has to play a starter's share before the
 * work he is getting counts as the job. Two weeks can be one blowout and
 * one bye-week fill-in.
 */
export const MIN_WEEKS_WITH_JOB = 3;

/** a backup who got the job, against what the man in front had been getting */
export interface Inherited {
  season: number;
  /** the cut he was still a backup at */
  week: number;
  position: string;
  playerId: string;
  playerName: string;
  /** his share of the snaps before the cut */
  snapShareBefore: number;
  /** the weeks after the cut he played a starter's share */
  weeksWithJob: number;
  /** what the man in front had a game through the cut */
  starterOpportunities: number;
  starterPoints: number;
  /** what he himself got a game over the weeks he had the job */
  opportunities: number;
  points: number;
  /** his own opportunities through the cut, all of them, not a rate */
  opportunitiesBefore: number;
  /** and the same as a rate, over the games his club has played */
  ownOpportunities: number;
  /** his points an opportunity before the cut, absent when he had too few */
  rateBefore?: number;
  /** and over the weeks he had the job */
  rateWithJob: number;
  /** what an opportunity paid at his position through the cut */
  positionRate: number;
}

/** how many opportunities a backup needs before his own rate is worth reading */
const ENOUGH_TO_READ_A_RATE = 15;

/**
 * Every backup at every cut of one season who went on to take the job,
 * with his work beside the work the man in front of him had been getting.
 * The division is the share of a job a next man up actually inherits.
 */
export function inheritanceIn(
  season: ContingentSeason, cuts: number[],
): Inherited[] {
  const { read, snaps } = season;
  const out: Inherited[] = [];

  for (const week of cuts) {
    const rates = positionRates(read, season.before, week);

    for (const [key, order] of peckingOrders(read, week)) {
      const position = key.split("|")[1] ?? "";
      const club = key.split("|")[0] ?? "";
      const top = order[0];

      if (!top || top.perGame < MEANINGFUL_PER_GAME) {
        continue;
      }

      const games = [...(read.clubWeeks.get(club) ?? [])]
        .filter((one) => one <= week).length;

      if (games === 0) {
        continue;
      }

      const starter = totalled(read, top.playerId, 1, week);

      for (const place of BEHIND) {
        const his = order[place - 1];

        if (!his) {
          continue;
        }

        const withJob = weeksWithTheJob(read, snaps, his.playerId, week);

        if (withJob.games < MIN_WEEKS_WITH_JOB) {
          continue;
        }

        const before = totalled(read, his.playerId, 1, week);

        out.push({
          season: read.season,
          week,
          position,
          playerId: his.playerId,
          playerName: read.names.get(his.playerId) ?? his.playerId,
          snapShareBefore: snapShareOver(snaps, his.playerId, 1, week).share,
          weeksWithJob: withJob.games,
          starterOpportunities: starter.opportunities / games,
          starterPoints: starter.points / games,
          opportunities: withJob.opportunities / withJob.games,
          points: withJob.points / withJob.games,
          opportunitiesBefore: before.opportunities,
          ownOpportunities: before.opportunities / games,
          rateBefore: before.opportunities >= ENOUGH_TO_READ_A_RATE
            ? before.points / before.opportunities
            : undefined,
          rateWithJob: withJob.opportunities === 0
            ? 0
            : withJob.points / withJob.opportunities,
          positionRate: rates.get(position) ?? 0,
        });
      }
    }
  }

  return out;
}

/** his work over the weeks after the cut he was on for a starter's share */
function weeksWithTheJob(
  read: OpportunitySeason,
  snaps: Map<string, Map<number, number>>,
  playerId: string,
  cut: number,
): Did & { games: number } {
  const summed = { ...nothing(), games: 0 };
  const his = read.weeks.get(playerId);

  for (const [week, pct] of snaps.get(playerId) ?? []) {
    const did = his?.get(week);

    if (week <= cut || pct < STARTER_SNAPS || !did) {
      continue;
    }

    add(summed, did);
    summed.games++;
  }

  return summed;
}

/* ---------- every season ---------- */

/** a backup, which is who the role question is about at all */
export const BEHIND = [2, 3];

export const isBackup = (one: ContingentRow): boolean =>
  BEHIND.includes(one.cut.depthRank);

export interface BuiltContingent {
  rows: ContingentRow[];
  /** the base rate the season after the last one would be scored with */
  openRate: Map<string, number>;
}

/**
 * Every cut of every season with its contingent features and its role
 * outcome. Seasons run in order so the base rate a season is scored with
 * is pooled from the seasons before it and never from itself.
 */
export async function buildContingent(
  rows: Row[], cuts: number[],
): Promise<BuiltContingent> {
  const seasons = [...new Set(rows.map((row) => row.cut.season))]
    .sort((a, b) => a - b);
  const reads = new Map<number, OpportunitySeason>();
  const rateTallies: Map<string, { open: number; of: number }>[] = [];
  const out: ContingentRow[] = [];

  const readFor = async (year: number) => {
    if (!reads.has(year)) {
      reads.set(
        year,
        readOpportunities(year, await loadPlayerStats(year).catch(() => [])),
      );
    }

    return reads.get(year)!;
  };

  for (const season of seasons) {
    const read = await readFor(season);
    const last = await readFor(season - 1);
    const missedFrom = [last, await readFor(season - 2)]
      .filter((one) => one.weeks.size > 0);
    const input: ContingentSeason = {
      read,
      before: last.weeks.size > 0 ? last : undefined,
      missedFrom,
      snaps: snapsById(read, await loadSnapCounts(season).catch(() => [])),
      roster: await rosterFactsFor(season),
      listed: await listedWeeksFor(season),
      openRate: pooledOpenRate(rateTallies),
    };

    for (const week of cuts) {
      out.push(...contingentRows(
        input, rows.filter((row) =>
          row.cut.season === season && row.cut.week === week),
        week,
      ));
    }

    rateTallies.push(openRatesIn(read, cuts));
  }

  return { rows: out, openRate: pooledOpenRate(rateTallies) };
}

/**
 * The same season assembly for a season still being played, where there
 * is no outcome to mark and the base rate comes from whatever the caller
 * has already built out of the seasons behind it.
 */
export async function contingentSeasonFor(
  season: number, openRate: Map<string, number>,
): Promise<ContingentSeason> {
  const readFor = async (year: number) => readOpportunities(
    year, await loadPlayerStats(year).catch(() => []),
  );
  const read = await readFor(season);
  const last = await readFor(season - 1);

  return {
    read,
    before: last.weeks.size > 0 ? last : undefined,
    missedFrom: [last, await readFor(season - 2)]
      .filter((one) => one.weeks.size > 0),
    snaps: snapsById(read, await loadSnapCounts(season).catch(() => [])),
    roster: await rosterFactsFor(season),
    listed: await listedWeeksFor(season),
    openRate,
  };
}

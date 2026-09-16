/**
 * The rows the sleeper bench is scored on: every priced player at a cut
 * week, what was known about him by then, and what he went on to do.
 *
 * `scripts/sleeperEval.ts` scores methods over these rows and
 * `scripts/sleeperLog.ts` prints the named picks. They share this
 * module so both read the same candidates and the same definition of a
 * hit: a candidate is a player at a priced position with at least one
 * game by the cut whose club still has games left, priced at
 * `UNDRAFTED_PRICE` when no board took him, and a hit is a finish
 * inside the position's starter tier over the rest of the season,
 * ranked on total points so missed weeks count against him. Each row
 * also has the in-season update on it, fitted on earlier seasons only.
 */

import { loadAdp, type AdpEntry } from "../data/adp.js";
import { normalizeName } from "../data/names.js";
import { loadPlayerStats, type PlayerWeekStats } from "../data/nflverse.js";
import {
  marketPriceAsOf, PRICED_POSITIONS, STARTER_TIER,
  type MarketPrice, type SeasonPrices,
} from "../features/marketPrice.js";
import {
  leverageUsage, loadLeverage, type LeverageRow, type Usage,
} from "../features/leverageUsage.js";
import {
  readPlayedWeeks, roleRowsFrom, SHIPPED_SHAPE,
  type SeasonWeeks as PlayedSeason,
} from "../features/inSeasonBoard.js";
import {
  fitInSeasonUpdate, fitRoleLevel, updateLevel,
  type InSeasonFit, type PlayedWeek, type RoleLevelRow, type UpdateCase,
} from "../features/inSeasonLevel.js";
import { UNDRAFTED_PRICE, type PlayerCut } from "../model/sleepers.js";
import { fantasyPoints, scoringRules } from "../scoring/fantasyPoints.js";

export const SEASONS = Array.from({ length: 10 }, (_, i) => 2016 + i);

/** the weeks a drafter is still able to do something about it */
export const CUTS = [4, 6, 8];

/** past this pick a player is cheap enough to be worth calling a sleeper */
export const TOP_PRICED = 100;

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
export interface Row {
  cut: PlayerCut;
  /** the club he was doing his work for at the cut */
  club: string;
  /** the weeks his club still had to play after the cut */
  weeksLeft: number;
  /** the games he actually played over those weeks */
  gamesAfter: number;
  restOfSeasonPpg: number;
  restOfSeasonTotal: number;
  /** he finished inside his position's starter tier over those weeks */
  hit: boolean;
  /** his total over the rest against the last total inside the tier */
  tierMargin: number;
}

/** everything one season needs before its cuts can be written out */
interface SeasonInput {
  season: number;
  read: SeasonWeeks;
  curve: MarketPrice;
  byName: Map<string, AdpEntry[]>;
  counted: LeverageRow[];
  /** the same season's games as the in-season update reads them */
  played: PlayedSeason;
  /** the update as it stood before this season started */
  inSeason: InSeasonFit;
}

function cutsFor(input: SeasonInput, week: number): Row[] {
  const { season, read, curve, byName, counted } = input;
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
    const said = updateLevel(input.inSeason, {
      anchor: quantiles.p50,
      position,
      weeks: gamesBy(input.played, playerId, week),
    });
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
        inSeasonPpg: said.ppg,
        roleLevelPpg: said.roleLevel,
      },
      club,
      weeksLeft: left,
      gamesAfter: rest.games,
      restOfSeasonPpg: rest.points / left,
      restOfSeasonTotal: rest.points,
      hit: false,
      tierMargin: 0,
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
      row.tierMargin = Number.isFinite(tierCut)
        ? row.restOfSeasonTotal - tierCut
        : 0;
    }
  }

  return rows;
}

/* ---------- what the season so far says about a candidate ---------- */

/** how many earlier seasons the role level is taught on */
const ROLE_SEASONS = 8;

const gamesBy = (
  played: PlayedSeason, playerId: string, week: number,
): PlayedWeek[] =>
  (played.weeks.get(playerId) ?? []).filter((one) => one.week <= week);

/**
 * The candidates of earlier seasons, as cases the update weights can be
 * fitted on. The anchor is the price curve's median at his price, which
 * is the preseason number this bench already reads him by, and the
 * target is the same rest of season the sleeper model predicts.
 */
function casesFrom(
  earlier: Row[], played: Map<number, PlayedSeason>,
): UpdateCase[] {
  const cases: UpdateCase[] = [];

  for (const row of earlier) {
    const season = played.get(row.cut.season);

    if (!season) {
      continue;
    }

    const weeks = gamesBy(season, row.cut.playerId, row.cut.week);

    if (weeks.length === 0) {
      continue;
    }

    cases.push({
      position: row.cut.position,
      anchor: row.cut.priceMedian,
      weeks,
      restPpg: row.restOfSeasonPpg,
    });
  }

  return cases;
}

/**
 * The update as a drafter could have had it before a season kicked off:
 * both the role level and the weights read only earlier seasons, so a
 * candidate is never scored by a fit that saw what he did. The earliest
 * priced season has no candidates behind it to fit weights on and takes
 * the shipped constants, which is why it stays out of the scoring.
 */
function inSeasonFitFor(
  season: number, played: Map<number, PlayedSeason>, earlier: Row[],
): InSeasonFit {
  const roleRows: RoleLevelRow[] = [];

  for (let year = season - ROLE_SEASONS; year < season; year++) {
    const read = played.get(year);

    if (read) {
      roleRows.push(...roleRowsFrom(read));
    }
  }

  if (roleRows.length === 0) {
    throw new Error(`no season before ${season} has games to fit a role level`);
  }

  const cases = casesFrom(earlier, played);

  if (cases.length === 0) {
    return { role: fitRoleLevel(roleRows), shape: SHIPPED_SHAPE };
  }

  return fitInSeasonUpdate(roleRows, cases);
}

/* ---------- putting the bench together ---------- */

export interface Built {
  rows: Row[];
  /** the seasons a price curve could be fitted for */
  priced: number[];
  skipped: Map<number, string>;
}

/** every season's games the update can read, the training years included */
async function playedFor(
  seasons: number[],
): Promise<Map<number, PlayedSeason>> {
  const first = Math.min(...seasons) - ROLE_SEASONS;
  const last = Math.max(...seasons);
  const played = new Map<number, PlayedSeason>();

  for (let year = first; year <= last; year++) {
    played.set(year, await readPlayedWeeks(year));
  }

  return played;
}

export async function build(seasons: number[]): Promise<Built> {
  const counted = await loadLeverage(seasons);
  const cache = new Map<number, SeasonPrices | null>();
  const played = await playedFor(seasons);
  const rows: Row[] = [];
  const priced: number[] = [];
  const skipped = new Map<number, string>();

  for (const season of [...seasons].sort((a, b) => a - b)) {
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

    const input: SeasonInput = {
      season,
      read: readSeason(await loadPlayerStats(season)),
      curve,
      byName: boardByName(await loadAdp(season, "ppr")),
      counted: lines,
      played: played.get(season)!,
      // the rows so far are every earlier season's, since seasons run in order
      inSeason: inSeasonFitFor(season, played, rows),
    };
    priced.push(season);

    for (const week of CUTS) {
      rows.push(...cutsFor(input, week));
    }
  }

  return { rows, priced, skipped };
}

export const cheap = (row: Row): boolean =>
  !row.cut.drafted || row.cut.price > TOP_PRICED;

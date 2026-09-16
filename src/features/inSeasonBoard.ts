/**
 * Putting the in-season update on the board.
 *
 * The model itself is arithmetic over a player's games. This reads
 * those games out of the weekly stats and the snap counts, fits the
 * role model on earlier seasons, and moves each player's projection to
 * what the season so far says he is worth from here.
 *
 * The weights are fitted rather than picked, by the rest-of-season
 * backtest that marks this against the preseason anchor, against a
 * player's points a game so far, and against a reader who knew the
 * answer.
 */

import { loadPlayerStats, loadSnapCounts } from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";
import { fantasyPoints } from "../scoring/fantasyPoints.js";
import { scoring } from "../scoring/active.js";
import {
  fitRoleLevel,
  updateLevel,
  type InSeasonFit,
  type PlayedWeek,
  type RoleLevelRow,
  type UpdateShape,
} from "./inSeasonLevel.js";

const LAST_WEEK = 18;
const ROLE_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
/** games of a season before it is worth training the role model on */
const MIN_ROLE_GAMES = 6;
/** how many earlier seasons the role model learns from */
const ROLE_SEASONS = 8;

/**
 * Fitted over 2018 to 2025. Usage takes half its weight after two
 * games and points after five, which is the gap between how fast a
 * role settles and how fast scoring does. A snap share move of twenty
 * points counts as the role changing outright.
 */
export const SHIPPED_SHAPE: UpdateShape = {
  decay: 0.9,
  breakGap: 0.2,
  roleCap: 0.5,
  roleGames: 2,
  pointsCap: 0.6,
  pointsGames: 5,
};

export interface SeasonWeeks {
  /** every game each player played, earliest first */
  weeks: Map<string, PlayedWeek[]>;
  /** what to call each player, since some callers have only his id */
  byName: Map<string, string>;
  /** what the weekly file files him at, which is not always his fantasy spot */
  filedAt: Map<string, string>;
}

/** a season's games as the update reads them */
export async function readPlayedWeeks(season: number): Promise<SeasonWeeks> {
  const stats = await loadPlayerStats(season).catch(() => []);
  const snaps = await loadSnapCounts(season).catch(() => []);
  const share = new Map<string, number>();

  for (const snap of snaps) {
    // the release has written this both as a share and as a percentage
    const pct = snap.offensePct > 1.5 ? snap.offensePct / 100 : snap.offensePct;
    share.set(`${normalizeName(snap.playerName)}|${snap.teamId}|${snap.week}`, pct);
  }

  const weeks = new Map<string, PlayedWeek[]>();
  const byName = new Map<string, string>();
  const filedAt = new Map<string, string>();

  for (const row of stats) {
    if (row.week > LAST_WEEK) {
      continue;
    }

    byName.set(row.playerId, row.playerName);
    filedAt.set(row.playerId, row.position);

    const his = weeks.get(row.playerId) ?? [];
    his.push({
      week: row.week,
      points: fantasyPoints(row.statLine, scoring()),
      snapShare:
        share.get(`${normalizeName(row.playerName)}|${row.teamId}|${row.week}`) ?? 0,
      targets: row.targets,
      carries: row.carries,
      airYards: row.airYards,
      passAttempts: row.passing.attempts,
    });
    weeks.set(row.playerId, his);
  }

  for (const his of weeks.values()) {
    his.sort((a, b) => a.week - b.week);
  }

  return { weeks, byName, filedAt };
}

/**
 * Whole player seasons, workload and scoring measured over the same
 * games, which is what the role model learns from. A part season is
 * left out, since a player who arrived in November has a per-game
 * average off three games and nothing else.
 */
export function roleRowsFrom(read: SeasonWeeks): RoleLevelRow[] {
  const rows: RoleLevelRow[] = [];

  for (const [playerId, his] of read.weeks) {
    const position = read.filedAt.get(playerId);

    if (!position || !ROLE_POSITIONS.has(position) || his.length < MIN_ROLE_GAMES) {
      continue;
    }

    const mean = (of: (w: PlayedWeek) => number) =>
      his.reduce((sum, w) => sum + of(w), 0) / his.length;

    rows.push({
      position,
      usage: {
        snapShare: mean((w) => w.snapShare),
        targets: mean((w) => w.targets),
        carries: mean((w) => w.carries),
        airYards: mean((w) => w.airYards),
        passAttempts: mean((w) => w.passAttempts),
      },
      ppg: mean((w) => w.points),
    });
  }

  return rows;
}

/** the role model, taught on the seasons before this one */
export async function fitForSeason(
  season: number,
  shape: UpdateShape = SHIPPED_SHAPE,
): Promise<InSeasonFit> {
  const rows: RoleLevelRow[] = [];

  for (let year = season - ROLE_SEASONS; year < season; year++) {
    rows.push(...roleRowsFrom(await readPlayedWeeks(year)));
  }

  return { role: fitRoleLevel(rows), shape };
}

interface BoardPlayer {
  playerId: string;
  position: string;
  projectedPpg: number;
}

/**
 * Move every projection on the board to what this season says, and
 * return how many moved. Before week 1 there is nothing to read and
 * the board is left as it was.
 */
export async function updateBoardLevels(
  players: BoardPlayer[],
  season: number,
): Promise<number> {
  const read = await readPlayedWeeks(season);

  if (read.weeks.size === 0) {
    return 0;
  }

  const fit = await fitForSeason(season);
  let moved = 0;

  for (const player of players) {
    const weeks = read.weeks.get(player.playerId);

    if (!weeks || weeks.length === 0) {
      continue;
    }

    player.projectedPpg = updateLevel(fit, {
      anchor: player.projectedPpg,
      position: player.position,
      weeks,
    }).ppg;
    moved++;
  }

  return moved;
}

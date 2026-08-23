/**
 * The weekly model needs things you only have once a season is
 * running: snaps, targets and points over the last four games. Before
 * kickoff we stand last season's per-game rates in their place, which
 * is the same trick the season model uses, and run the weekly kernel
 * over the schedule.
 *
 * What this buys over multiplying a season average by an opponent
 * factor is that a player's weeks stop being the same number 17 times.
 * Opponent strength, home and away, and the game's expected scoring
 * all move him, and they move a possession receiver and a deep threat
 * by different amounts because their usage rows differ.
 */

import type { GameRow } from "../data/nflverse.js";
import type { SeasonExample } from "./seasonModel.js";
import type { WeeklyExample } from "./weekly.js";
import { weeklyRow } from "./weeklyModel.js";
import { predictRidge } from "../backtest/ridge.js";

/** league-average implied points when no line exists, as the weekly model assumes */
const NEUTRAL_TOTAL = 21.5;
const NEUTRAL_PASS_RATE = 0.57;

export interface PreseasonWeeklyInput {
  season: number;
  games: GameRow[];
  weeklyWeights: number[];
  /** what the season model expects him to average */
  projectedPpg: Map<string, number>;
  exampleById: Map<string, SeasonExample>;
  positionById: Map<string, string>;
  teamById: Map<string, string>;
  /** how soft each defence was against a position, 1 is average */
  oppAdjust: (position: string, opponent: string) => number;
  /**
   * The same before it is pulled back toward level.
   *
   * The weekly model was trained on defences as they actually were,
   * so handing it the blunted number made every matchup look alike
   * and a receiver's seventeen weeks came out within half a point of
   * each other.
   */
  oppIndex: (position: string, opponent: string) => number;
  /** points a team scored per game last season, for the implied total */
  teamScoring: Map<string, number>;
  /** each team's neutral pass rate last season */
  passRate: Map<string, number>;
}

export interface WeeklyProjection {
  week: number;
  opponent: string;
  home: boolean;
  points: number;
}

function scheduleOf(games: GameRow[], season: number) {
  const byTeam = new Map<string, { week: number; opponent: string; home: boolean }[]>();

  for (const game of games) {
    // seventeen games across eighteen weeks, so the cut goes at 18
    if (game.season !== season || game.week > 18) {
      continue;
    }

    for (const [team, opponent, home] of [
      [game.homeTeamId, game.awayTeamId, true],
      [game.awayTeamId, game.homeTeamId, false],
    ] as [string, string, boolean][]) {
      byTeam.set(team, [
        ...(byTeam.get(team) ?? []),
        { week: game.week, opponent, home },
      ]);
    }
  }

  return byTeam;
}

/**
 * A team's expected points, halfway between what it scored last season
 * and the league average, nudged by how good the defence it faces is.
 */
function impliedTotal(
  team: string,
  opponent: string,
  teamScoring: Map<string, number>,
  oppAdjust: (position: string, opponent: string) => number,
): number {
  const own = teamScoring.get(team) ?? NEUTRAL_TOTAL;
  const regressed = (own + NEUTRAL_TOTAL) / 2;
  // oppAdjust runs about 1 either way; blunt it so a soft defence is
  // worth a couple of points rather than a quarter of the total
  const defence = 1 + (oppAdjust("WR", opponent) - 1) * 0.5;
  return regressed * defence;
}

export function preseasonWeekly(
  input: PreseasonWeeklyInput,
): Map<string, WeeklyProjection[]> {
  const schedule = scheduleOf(input.games, input.season);
  const out = new Map<string, WeeklyProjection[]>();

  for (const [playerId, ppg] of input.projectedPpg) {
    const team = input.teamById.get(playerId);
    const position = input.positionById.get(playerId);
    const slots = team ? schedule.get(team) : undefined;

    if (!team || !position || !slots) {
      continue;
    }

    const e = input.exampleById.get(playerId);
    const weeks: WeeklyProjection[] = [];

    for (const slot of slots) {
      const row: WeeklyExample = {
        playerId,
        playerName: "",
        position,
        season: input.season,
        week: slot.week,
        target: 0,
        targetTargets: 0,
        targetCarries: 0,
        targetReceptions: 0,
        targetRecYds: 0,
        targetRushYds: 0,
        // last season's rates stand in for this season's recent form
        last4: ppg,
        seasonPpg: ppg,
        prevPpg: e?.prevPpg ?? ppg,
        targetsRecent: e?.targetsPerGame ?? 0,
        carriesRecent: e?.carriesPerGame ?? 0,
        airYardsRecent: e?.airYardsPerGame ?? 0,
        receptionsRecent: 0,
        recYdsRecent: 0,
        rushYdsRecent: 0,
        snapRecent: e?.snapPct ?? 0,
        oppIndex: input.oppIndex(position, slot.opponent),
        home: slot.home,
        impliedTotal: impliedTotal(team, slot.opponent, input.teamScoring, input.oppAdjust),
        passTendency: input.passRate.get(team) ?? NEUTRAL_PASS_RATE,
        teamId: team,
        opponent: slot.opponent,
      };
      weeks.push({
        week: slot.week,
        opponent: slot.opponent,
        home: slot.home,
        points: Math.max(0, predictRidge(input.weeklyWeights, weeklyRow(row))),
      });
    }

    weeks.sort((a, b) => a.week - b.week);
    out.set(playerId, weeks);
  }

  return out;
}

/**
 * The weekly kernel is trained to predict one game, so its level can
 * drift from the season model's. Rescale each player's weeks to hit
 * his season projection, keeping the week-to-week shape.
 */
export function anchorToSeason(
  weeks: WeeklyProjection[],
  projectedPpg: number,
): WeeklyProjection[] {
  const mean = weeks.reduce((sum, w) => sum + w.points, 0) / (weeks.length || 1);

  if (mean <= 0) {
    return weeks.map((w) => ({ ...w, points: projectedPpg }));
  }

  return weeks.map((w) => ({ ...w, points: (w.points / mean) * projectedPpg }));
}

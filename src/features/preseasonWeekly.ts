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

import { loadPlayerStats } from "../data/nflverse.js";
import type { GameRow } from "../data/nflverse.js";
import { loadTendencies } from "../data/tendencies.js";
import { loadWeeklyInjuryStatus } from "../data/weeklyStatus.js";
import { fantasyPoints } from "../scoring/fantasyPoints.js";
import { scoring } from "../scoring/active.js";
import type { PreseasonWorld } from "./preseason.js";
import type { SeasonExample } from "./seasonModel.js";
import type { WeeklyExample } from "./weekly.js";
import { NO_CHANGE, staffChangesFor, type StaffChange } from "./staffChange.js";
import {
  predictWeeklyByPosition,
  type WeeklyByPosition,
} from "./fitWeeklyByPosition.js";

/** league-average implied points when no line exists, as the weekly model assumes */
const NEUTRAL_TOTAL = 21.5;
const NEUTRAL_PASS_RATE = 0.57;

export interface PreseasonWeeklyInput {
  season: number;
  games: GameRow[];
  weekly: WeeklyByPosition;
  /** what the season model expects him to average */
  projectedPpg: Map<string, number>;
  exampleById: Map<string, SeasonExample>;
  positionById: Map<string, string>;
  teamById: Map<string, string>;
  nameById: Map<string, string>;
  /** whether his club listed him questionable that week, if it has yet */
  isQuestionable: (playerId: string, week: number) => boolean;
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
  /** what changed on each club's offensive staff this season */
  staff: Map<string, StaffChange>;
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
  // Trained on the Vegas number, which is what the team is expected to
  // score, so this stays team level and asks the receiving question for
  // everyone. Position enters the model through oppIndex instead.
  const defence = 1 + (oppAdjust("WR", opponent) - 1) * 0.5;
  return regressed * defence;
}

/**
 * The rows the weekly model would see for every player's every week,
 * had the season started. The start-sit tool reads these directly, so
 * it can rank a week before anyone has played one.
 */
export function preseasonWeeklyExamples(
  input: PreseasonWeeklyInput,
): Map<string, WeeklyExample[]> {
  const schedule = scheduleOf(input.games, input.season);
  const out = new Map<string, WeeklyExample[]>();

  for (const [playerId, ppg] of input.projectedPpg) {
    const team = input.teamById.get(playerId);
    const position = input.positionById.get(playerId);
    const slots = team ? schedule.get(team) : undefined;

    if (!team || !position || !slots) {
      continue;
    }

    const e = input.exampleById.get(playerId);
    const weeks: WeeklyExample[] = [];

    for (const slot of slots) {
      const row: WeeklyExample = {
        playerId,
        playerName: input.nameById.get(playerId) ?? playerId,
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
        // nobody has missed a game that has not been played
        gamesMissedRecent: 0,
        // nobody is ruled out before the season starts, so there is
        // nothing to redistribute
        targetsExpected: e?.targetsPerGame ?? 0,
        carriesExpected: e?.carriesPerGame ?? 0,
        airYardsRecent: e?.airYardsPerGame ?? 0,
        receptionsRecent: 0,
        recYdsRecent: 0,
        rushYdsRecent: 0,
        snapRecent: e?.snapPct ?? 0,
        oppIndex: input.oppIndex(position, slot.opponent),
        home: slot.home,
        impliedTotal: impliedTotal(
          team, slot.opponent, input.teamScoring, input.oppAdjust,
        ),
        // nobody has hung a line on a game this far out, and there is no
        // recent form to take a share of either
        spread: 0,
        targetShareRecent: 0,
        backfieldShareRecent: 0,
        passTendency: input.passRate.get(team) ?? NEUTRAL_PASS_RATE,
        staff: input.staff.get(team) ?? NO_CHANGE,
        // in August no club has published an injury report for December,
        // so out of season this is false for everyone
        questionable: input.isQuestionable(playerId, slot.week),
        limitedPractice: false,
        // no rooms have lost anyone yet, so there is no share to move
        absenceShare: 0,
        qbAbsenceShare: 0,
        depthRank: 0,
        depthKnown: false,
        teamId: team,
        opponent: slot.opponent,
      };
      weeks.push(row);
    }

    weeks.sort((a, b) => a.week - b.week);
    out.set(playerId, weeks);
  }

  return out;
}

export function preseasonWeekly(
  input: PreseasonWeeklyInput,
): Map<string, WeeklyProjection[]> {
  const out = new Map<string, WeeklyProjection[]>();

  for (const [playerId, weeks] of preseasonWeeklyExamples(input)) {
    out.set(
      playerId,
      weeks.map((row) => ({
        week: row.week,
        opponent: row.opponent,
        home: row.home,
        points: Math.max(0, predictWeeklyByPosition(input.weekly, row)),
      })),
    );
  }

  return out;
}

/**
 * Everything the preseason weekly path needs, gathered from a world
 * that is already built. Three callers want the same last-season
 * scoring, pass tendency and injury report, so it is assembled once.
 */
export async function preseasonWeeklyInput(
  world: PreseasonWorld,
  exampleById: Map<string, SeasonExample>,
): Promise<PreseasonWeeklyInput> {
  const scored = new Map<string, { points: number; weeks: Set<number> }>();

  for (const w of await loadPlayerStats(world.season - 1)) {
    const entry = scored.get(w.teamId) ??
      { points: 0, weeks: new Set<number>() };
    entry.points += fantasyPoints(w.statLine, scoring());
    entry.weeks.add(w.week);
    scored.set(w.teamId, entry);
  }

  const passRate = new Map<string, number>();

  for (const [key, tendency] of await loadTendencies()) {
    const [team, at] = key.split("|");

    if (Number(at) === world.season - 1) {
      passRate.set(team!, tendency.neutralPassRate);
    }
  }

  const status = await loadWeeklyInjuryStatus(world.season);

  return {
    season: world.season,
    games: world.games,
    weekly: world.weeklyByPosition,
    projectedPpg: new Map(
      world.players.map((p) => [p.playerId, p.projectedPpg]),
    ),
    exampleById,
    positionById: new Map(world.players.map((p) => [p.playerId, p.position])),
    teamById: new Map(world.players.map((p) => [p.playerId, p.teamId])),
    nameById: new Map(world.players.map((p) => [p.playerId, p.name])),
    isQuestionable: (playerId, week) =>
      status.get(`${playerId}|${week}`)?.questionable ?? false,
    oppAdjust: world.oppAdjust,
    oppIndex: world.oppIndex,
    teamScoring: new Map(
      [...scored].map(([team, e]) =>
        [team, e.points / Math.max(1, e.weeks.size)]),
    ),
    passRate,
    staff: (await staffChangesFor(world.season)).changes,
  };
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

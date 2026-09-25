/**
 * The rows of a week's slate for the skill positions, and the rows the
 * board writes for the players the weekly model has no line for.
 *
 * The weekly model only speaks for a player with a game behind him this
 * season, so a starter back from injury, a rookie who has not played yet
 * and a quarterback promoted this week have no example to predict from.
 * Left off the slate, the app fell back to his season-long game with no
 * opponent, no Sleeper number and no injury word. Each of them gets a row
 * here instead, built the same way, with the board's own line for that
 * week standing in for the weekly model's.
 *
 * Defences and kickers have their own rows in buildSite.
 */

import type { ResidualModel } from "../src/backtest/intervals.js";
import { outcomeQuantile } from "../src/backtest/intervals.js";
import { normalizeName } from "../src/data/names.js";
import {
  projectionKey,
  sleeperPointsUnder,
  type SleeperProjection,
} from "../src/data/sleeperProjections.js";
import type { WeatherNote } from "../src/data/weatherWeekly.js";
import type { WeekStatus } from "../src/data/weeklyStatus.js";
import {
  blendPoints,
  debiasedSleeper,
  SHIPPED_BLEND_WEIGHT,
} from "../src/features/sleeperBlend.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { scoring } from "../src/scoring/active.js";

/**
 * What a row says about the player and his week. A weekly example has
 * all of it; for a player without one the board and the injury report
 * fill it in.
 */
export type SlateSubject = Pick<
  WeeklyExample,
  | "playerName" | "position" | "teamId" | "home" | "opponent" | "ruledOut"
  | "questionable" | "status" | "receptionsRecent" | "snapRecent"
  | "gamesMissedRecent" | "absenceShare"
>;

/** whose line `ours` is: the weekly model's, or the board's for that week */
export type LineFrom = "model" | "board";

/** the forecast for his fixture, and what it already did to `ours` */
export interface Sky {
  note: WeatherNote | undefined;
  lift: number;
}

/**
 * One row a player, in the slate file the app reads. `ours` is our line
 * and `sleeper` is Sleeper's number, null when they have no row for him.
 * A player Sleeper listed without a number is a backup or out, so he
 * gets a Sleeper 0 and an average of 0; one Sleeper never listed keeps
 * ours alone. Otherwise `average` is the two blended, and the file is
 * sorted by it. `floor` and `ceiling` are the tenth and ninetieth of the
 * outcome around it. `snaps` is a whole percent and `gamesMissed` is out
 * of his last four club weeks. Every point figure is in the build's
 * scoring, and `catches` lets a league paying a catch differently move
 * them. A row whose `ours` came from the board says so in `lineFrom`.
 */
export function slateRow(
  residuals: ResidualModel,
  e: SlateSubject,
  ours: number,
  projection: SleeperProjection | undefined,
  quiet: boolean,
  sky?: Sky,
  from: LineFrom = "model",
) {
  const said = projection
    ? sleeperPointsUnder(projection, scoring().receptions)
    : quiet ? 0 : undefined;
  // his club has said he is not playing, so there is no week to project.
  // He stays on the slate with the word they used, since leaving him off
  // sent the app to his season-long game and it started him.
  const level = e.ruledOut ? 0 : ours;
  const sleeper = e.ruledOut ? 0 : said;
  // Sleeper leaves a player blank when he is not going to play, and a
  // half of our number would still rank him over players who will
  const average =
    sleeper === undefined
      ? level
      : sleeper === 0
        ? 0
        : blendPoints(
          level, debiasedSleeper(e.position, sleeper), SHIPPED_BLEND_WEIGHT);
  // a player who is not playing has no week to draw around
  const quantile = (q: number) =>
    average === 0 ? 0 : outcomeQuantile(residuals, e.position, average, q);

  return {
    name: e.playerName,
    key: normalizeName(e.playerName),
    position: e.position,
    team: e.teamId,
    opponent: (e.home ? "v " : "@ ") + e.opponent,
    ours: Number(level.toFixed(1)),
    sleeper: sleeper === undefined ? null : Number(sleeper.toFixed(1)),
    average: Number(average.toFixed(1)),
    floor: Number(quantile(0.1).toFixed(1)),
    ceiling: Number(quantile(0.9).toFixed(1)),
    q1: Number(quantile(0.25).toFixed(1)),
    q3: Number(quantile(0.75).toFixed(1)),
    catches: Number((projection?.catches ?? e.receptionsRecent).toFixed(2)),
    snaps: Math.round(e.snapRecent * 100),
    questionable: e.questionable,
    ruledOut: e.ruledOut,
    status: e.status,
    gamesMissed: e.gamesMissedRecent,
    absenceShare: Number(e.absenceShare.toFixed(2)),
    // left off a mild day entirely, which is most rows
    ...(sky?.note ? { weather: sky.note } : {}),
    ...(sky && sky.lift !== 1
      ? { weatherLift: Number(sky.lift.toFixed(3)) }
      : {}),
    // left off the model's rows, which are most of them
    ...(from === "board" ? { lineFrom: "board" as const } : {}),
  };
}

export type SlateRowShape = ReturnType<typeof slateRow>;

/** a board player as a slate row for one week needs him */
export interface BoardPlayer {
  playerId: string;
  name: string;
  position: string;
  teamId: string;
  /** the board's line for him that week, before Sleeper is blended in */
  line: number;
  /** his catches a game on the board, where Sleeper does not say */
  catches: number;
  /** his targets over his touches, which decides how the wind treats a back */
  catchShare: number;
}

/** one side's game in the week */
export interface WeekFixture {
  against: string;
  home: boolean;
}

/** everything about the week that a board player's row is built from */
export interface BoardWeek {
  season: number;
  week: number;
  residuals: ResidualModel;
  /** every side with a game that week, by its code */
  fixtures: Map<string, WeekFixture>;
  /** the rows already written, whose players the board must not repeat */
  written: { key: string }[];
  /** the ids the weekly model wrote a row for */
  modelled: Set<string>;
  /** what the injury report says of him that week */
  statusOf: (playerId: string) => WeekStatus | undefined;
  projections: Map<string, SleeperProjection>;
  quiet: Set<string>;
  /** how many of his side's recent game weeks he did not play in */
  missedOf: (playerId: string, team: string) => number;
  skyOf: (team: string, position: string, catchShare: number) => Sky;
}

/** where each side plays in one week; a side on its bye has no entry */
export function fixturesIn(
  games: { season: number; week: number; homeTeamId: string; awayTeamId: string }[],
  season: number,
  week: number,
): Map<string, WeekFixture> {
  const fixtures = new Map<string, WeekFixture>();

  for (const g of games) {
    if (g.season !== season || g.week !== week) {
      continue;
    }

    fixtures.set(g.homeTeamId, { against: g.awayTeamId, home: true });
    fixtures.set(g.awayTeamId, { against: g.homeTeamId, home: false });
  }

  return fixtures;
}

/**
 * A row for every board player the weekly model skipped whose side plays
 * that week. A side on its bye is left to the app, which already writes
 * that player a row of zeros. A player whose key another row already has
 * is left off too, since the app finds a row by that key and a second one
 * would replace the first.
 */
export function boardSlateRows(
  players: BoardPlayer[], at: BoardWeek,
): SlateRowShape[] {
  const taken = new Set(at.written.map((row) => row.key));
  const rows: SlateRowShape[] = [];

  for (const p of players) {
    const fixture = at.fixtures.get(p.teamId);
    const key = normalizeName(p.name);

    if (!fixture || at.modelled.has(p.playerId) || taken.has(key)) {
      continue;
    }

    taken.add(key);
    const status = at.statusOf(p.playerId);
    const sky = at.skyOf(p.teamId, p.position, p.catchShare);
    const subject: SlateSubject = {
      playerName: p.name,
      position: p.position,
      teamId: p.teamId,
      home: fixture.home,
      opponent: fixture.against,
      ruledOut: status?.out ?? false,
      questionable: status?.questionable ?? false,
      status: status?.report ?? "",
      receptionsRecent: p.catches,
      snapRecent: 0,
      gamesMissedRecent: at.missedOf(p.playerId, p.teamId),
      absenceShare: 0,
    };
    const said = projectionKey(at.season, at.week, p.playerId);

    rows.push(slateRow(
      at.residuals,
      subject,
      Math.max(0, p.line) * sky.lift,
      at.projections.get(said),
      at.quiet.has(said),
      sky,
      "board",
    ));
  }

  return rows;
}

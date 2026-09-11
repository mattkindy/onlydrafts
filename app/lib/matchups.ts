/**
 * This week's head to head games, with a win chance for each side.
 *
 * The provider says what everybody has scored so far. What is left to
 * come is drawn from the week's projections, and how much is left
 * depends on where each man's game is: nothing more for a game that has
 * finished, a whole week for one that has not kicked off, and a share of
 * one for a game in progress. The public ESPN scoreboard is what says
 * which of the three a game is in, and it needs no sign in.
 *
 * The draws are independent across starters for now, so a side stacked
 * with men in the same game reads narrower than it should. The copula
 * being built in winShare.ts will pick this up later.
 */

import type { Matchup } from "./providers.ts";
import type { SlateRow } from "./slate.ts";
import { weeksFromSpread } from "./spread.ts";
import { winChance } from "./winShare.ts";

export const SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

export interface GameState {
  where: "pre" | "in" | "post";
  /** how much of the game is still to play, nought to one */
  left: number;
}

/** four quarters of fifteen minutes */
const REGULATION = 60;

/** and an overtime period, which is ten in the regular season */
const OVERTIME = 10;

/**
 * ESPN's code for a pro team against the board's, where the two differ.
 * Everything else already matches, including JAX.
 */
const RENAMED: Record<string, string> = { WSH: "WAS", LAR: "LA" };

const boardTeam = (abbreviation: string) => {
  const code = abbreviation.toUpperCase();

  return RENAMED[code] ?? code;
};

/** minutes and seconds off the clock, as a number of minutes */
function clockMinutes(displayClock: string | undefined): number {
  const said = /(\d+):(\d+)/.exec(displayClock ?? "");

  if (!said) {
    return 0;
  }

  return Number(said[1]) + Number(said[2]) / 60;
}

/**
 * How much of a game in progress is left. Overtime counts as a little
 * more rather than as nothing, since a tie at the whistle still has
 * points to come.
 */
export function fractionLeft(
  period: number | undefined, displayClock: string | undefined,
): number {
  const at = period ?? 1;
  const onTheClock = clockMinutes(displayClock);

  if (at > 4) {
    return Math.min(1, onTheClock / REGULATION);
  }

  const quartersToCome = Math.max(0, 4 - at) * 15;

  return Math.min(1, Math.max(0, (quartersToCome + onTheClock) / REGULATION));
}

interface ScoreboardStatus {
  period?: number;
  displayClock?: string;
  type?: { state?: string };
}

interface ScoreboardEvent {
  status?: ScoreboardStatus;
  competitions?: {
    status?: ScoreboardStatus;
    competitors?: { team?: { abbreviation?: string } }[];
  }[];
}

/** one game's state, read off however the scoreboard describes it */
function stateOf(status: ScoreboardStatus | undefined): GameState {
  const where = status?.type?.state === "in"
    ? "in"
    : status?.type?.state === "post" ? "post" : "pre";

  if (where === "post") {
    return { where, left: 0 };
  }

  if (where === "pre") {
    return { where, left: 1 };
  }

  return { where, left: fractionLeft(status?.period, status?.displayClock) };
}

/** every team playing this week, and where its game has got to */
export function statesFrom(said: {
  events?: ScoreboardEvent[];
}): Map<string, GameState> {
  const out = new Map<string, GameState>();

  for (const event of said.events ?? []) {
    const game = event.competitions?.[0];
    const state = stateOf(game?.status ?? event.status);

    for (const side of game?.competitors ?? []) {
      const code = side.team?.abbreviation;

      if (code) {
        out.set(boardTeam(code), state);
      }
    }
  }

  return out;
}

export async function gameStates(): Promise<Map<string, GameState>> {
  const answered = await fetch(SCOREBOARD);

  if (!answered.ok) {
    throw new Error("ESPN would not hand over the scoreboard.");
  }

  return statesFrom(await answered.json());
}

/**
 * A man's week read as a spread. Two of the five figures the drawing
 * wants are not shipped per week, so each one is put halfway between the
 * two either side of it.
 */
const spreadOf = (row: SlateRow) => ({
  ev: row.blend,
  mid: row.blend,
  low: row.floor,
  high: row.ceiling,
  q1: (row.floor + row.blend) / 2,
  q3: (row.blend + row.ceiling) / 2,
});

/**
 * What one starter might still add to his side, draw by draw. A man
 * whose game is over adds nothing, and so does one the week has no
 * projection for, since all anybody knows about him is the score.
 */
function toComeFor(
  starter: { key: string; points: number },
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws: number,
): number[] {
  const row = rows.get(starter.key);

  if (!row) {
    return new Array(draws).fill(0) as number[];
  }

  const state = states.get(row.team.toUpperCase()) ?? { where: "pre", left: 1 };

  if (state.left <= 0) {
    return new Array(draws).fill(0) as number[];
  }

  const week = weeksFromSpread(spreadOf(row), starter.key, draws);

  return state.left >= 1 ? week : week.map((points) => points * state.left);
}

/** what a side ends the week on, draw by draw */
export function sideTotals(
  side: Matchup["sides"][number],
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws: number,
): number[] {
  const totals = new Array(draws).fill(0) as number[];

  for (const starter of side.starters) {
    const toCome = toComeFor(starter, rows, states, draws);

    for (let i = 0; i < draws; i++) {
      totals[i] = totals[i]! + starter.points + toCome[i]!;
    }
  }

  return totals;
}

/** how often each side of a matchup wins it from here */
export function oddsFor(
  matchup: Matchup,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws = 4000,
): [number, number] {
  const home = sideTotals(matchup.sides[0], rows, states, draws);
  const away = sideTotals(matchup.sides[1], rows, states, draws);
  const p = winChance(home, away);

  return [p, 1 - p];
}

/** where a starter's own game has got to, for the lineup under a side */
export function starterState(
  starter: { key: string },
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
): GameState {
  const row = rows.get(starter.key);

  if (!row) {
    return { where: "post", left: 0 };
  }

  return states.get(row.team.toUpperCase()) ?? { where: "pre", left: 1 };
}

/**
 * One NFL game as a scoreboard describes it, whichever provider's
 * scoreboard that is.
 *
 * ESPN's public scoreboard and Sleeper's scores feed are both read into
 * this, in the board's team codes, and the win chances and the remainder
 * engine read only this. A new source of game state needs one reader
 * that fills it in and nothing downstream changes.
 */

export type Where = "pre" | "in" | "post";

export interface GameRead {
  where: Where;
  home: string;
  away: string;
  points: Record<string, number>;
  /** kickoff, in epoch ms, where the feed gives one */
  kickoff?: number;
  /** the quarter, five and up for overtime */
  period: number;
  /** seconds left in the period */
  clock: number;
  withBall?: string;
  /** yards from the goal line the team with the ball is going for */
  yardline?: number;
  down?: number;
  toGo?: number;
  timeouts: Record<string, number>;
  redZone: boolean;
}

/** a clock written as "12:34", in seconds, or null when it is not one */
export function clockSeconds(said: string | null | undefined): number | null {
  const read = /(\d+):(\d+)/.exec(said ?? "");

  if (!read) {
    return null;
  }

  return Number(read[1]) * 60 + Number(read[2]);
}

/** a yard line pulled onto the field, since the engine has no goal line square */
export const onTheField = (yards: number) => Math.min(99, Math.max(1, yards));

/** a down the engine can play, which rules out the zero between plays */
export const downOf = (down: number | null | undefined) =>
  typeof down === "number" && down >= 1 && down <= 4 ? down : undefined;

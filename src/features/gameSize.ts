/**
 * How big an afternoon this is, from the betting line.
 *
 * The walk splits an offence between its players well and sizes the
 * afternoon badly. It ranks how many points a team scores at about .12
 * where the line ranks it at .39, and within one player the line's
 * number for his team on its own beats the whole simulation, .068
 * against .049.
 *
 * So take the size from the market and the split from the walk. The
 * older weekly model did this and the drive walk was written without
 * it.
 */

/** what a game is priced at, as the two sides see it */
export interface Line {
  /** points the game is expected to reach */
  total: number;
  /** points this team is favoured by, negative as an underdog */
  favouredBy: number;
}

/** what a neutral game is expected to total, over 2021 to 2025 */
export const NEUTRAL_TOTAL = 45;

/** the points the market expects this team, not the pair, to score */
export function impliedFor(line: Line): number {
  return line.total / 2 + line.favouredBy / 2;
}

/**
 * How much to move a projection built without knowing the game.
 *
 * The walk already produces a man's ordinary week, so this says how
 * much better or worse than ordinary this particular week looks. A
 * floor keeps a team priced for nothing from zeroing out its players.
 */
export function sizeOf(line: Line, most = 0.4): number {
  const implied = impliedFor(line);
  const ordinary = NEUTRAL_TOTAL / 2;
  const raw = implied / ordinary;

  return Math.max(1 - most, Math.min(1 + most, raw));
}

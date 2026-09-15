/**
 * How much a game was still in the balance when a play was run.
 *
 * A back with eight first quarter carries in a tie game and one with
 * twelve carries down twenty one have the same raw usage and say
 * completely different things about what the staff thinks of him. This
 * puts a number between zero and one on every play, so work taken while
 * the result was open can be counted apart from work taken after it was
 * settled.
 *
 * Two shapes are here because choosing between them is a measurement
 * rather than a preference. The leverage probe reports both and
 * `src/README.md` says which won.
 */

export type LeverageShape = "doubt" | "margin";

/** the state a play was run from, off the play file's own columns */
export interface PlayState {
  /** win probability for the side with the ball, absent in the odd row */
  winProbability?: number;
  /** the score as the side with the ball saw it, so trailing is negative */
  margin: number;
  /** seconds left in regulation, which the play file gives as 0 in overtime */
  secondsLeft: number;
}

const QUARTER_SECONDS = 900;

/**
 * Where a fourth quarter margin stops being in doubt, and where it is
 * gone. This repo has measured before that a staff starts resting people
 * in the fourth once the margin passes nine points and takes the top
 * back and the quarterback off for good past seventeen.
 */
const IN_DOUBT = 9;
const GONE = 17;

/**
 * Nothing counts as safer than the last five minutes of a close game.
 * Without a floor the thresholds go to zero as the clock does, and a side
 * up a field goal with ten seconds left, which is as tense as a game
 * gets, would count for nothing.
 */
const CLOCK_FLOOR = 300;

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Off the score and the clock. The two thresholds scale back through the
 * rest of the game by the square root of the time left, which is how far
 * a score can drift in that time, so nine points with a quarter to go is
 * eighteen at kickoff.
 */
function marginWeight(state: PlayState): number {
  const left = Math.max(state.secondsLeft, CLOCK_FLOOR);
  const drift = Math.sqrt(left / QUARTER_SECONDS);
  const open = IN_DOUBT * drift;
  const decided = GONE * drift;

  return clamp((decided - Math.abs(state.margin)) / (decided - open));
}

/**
 * How much doubt is left about who wins. One at even, and it falls away
 * smoothly, with the clock coming in on its own: a three score lead in
 * the first quarter still leaves plenty of doubt where the same lead with
 * five minutes left leaves almost none.
 */
function doubtWeight(state: PlayState): number {
  const chance = state.winProbability;

  // A row with no win probability is better read off the scoreboard than
  // thrown away, since dropping it would take the team total the share is
  // divided by down with it.
  if (chance === undefined || !Number.isFinite(chance)) {
    return marginWeight(state);
  }

  return clamp(4 * chance * (1 - chance));
}

const SHAPES: Record<LeverageShape, (state: PlayState) => number> = {
  doubt: doubtWeight,
  margin: marginWeight,
};

/**
 * The score and the clock, because they won. `margin` ordered the next
 * four weeks better in 587 of the 987 season weeks the probe counts,
 * where `doubt` managed 555.
 */
export const SHIPPED_SHAPE: LeverageShape = "margin";

/**
 * Which shape the aggregate and the feature use. Set `LEVERAGE_SHAPE` to
 * the other name to count the other way and measure the two against each
 * other again. The aggregate writes a file of its own when it is set, so
 * the shipped one is left alone.
 */
const asked = process.env["LEVERAGE_SHAPE"] ?? "";

export const LEVERAGE_SHAPE: LeverageShape =
  asked in SHAPES ? (asked as LeverageShape) : SHIPPED_SHAPE;

/**
 * Both shapes are symmetric in the sign of the margin. A side in front
 * running the clock down and a side behind throwing it every snap both
 * hand work to people who would not be getting it in a close game.
 */
export function leverageWeight(
  state: PlayState,
  shape: LeverageShape = LEVERAGE_SHAPE,
): number {
  return SHAPES[shape](state);
}

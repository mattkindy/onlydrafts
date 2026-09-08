/**
 * A man's floor and ceiling for a week, and where they came from.
 *
 * The pooled residuals give two men with the same projection the same
 * band, because that is all a projection-and-position lookup can know.
 * The walk plays his week forty times, so it has a band of his own.
 * Where the walk played him, his own games win; where it did not, we
 * fall back to the pooled band.
 *
 * The walk deals every run from one world, so its games miss the role
 * changes and the hurt teammates a played week brings with it.
 * `DEALT_WIDER` stretches the band around its middle to put that back.
 */

import { DEALT_WIDER } from "./walkWeek.js";
import type { RunSpread } from "./runSpread.js";

export interface Band {
  floor: number;
  ceiling: number;
  from: "walk" | "pooled";
}

/** below this many dealt games his tenth and ninetieth are noise */
export const ENOUGH_RUNS = 20;

export function bandFor(
  walk: RunSpread | undefined,
  pooled: { floor: number; ceiling: number },
  wider = DEALT_WIDER,
): Band {
  if (!walk || walk.runs < ENOUGH_RUNS || walk.p50 <= 0) {
    return { ...pooled, from: "pooled" };
  }

  const stretched = (edge: number) =>
    Math.max(0, walk.p50 + (edge - walk.p50) * wider);

  return {
    floor: stretched(walk.p10),
    ceiling: stretched(walk.p90),
    from: "walk",
  };
}

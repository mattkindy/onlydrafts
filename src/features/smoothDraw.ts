/**
 * Drawing a gain from a pool of past ones, with the gaps filled in.
 *
 * Picking a past play straight out of the pool means the only gains
 * that can ever happen are ones that already have, so a thin pool
 * repeats the same handful of numbers. Widening until three hundred
 * plays fixes that by borrowing from neighbouring situations, which
 * costs resolution: third and one at the goal line ends up carrying
 * plays from third and three at the four.
 *
 * Smoothing buys some of that back. A drawn play is nudged by a little
 * noise, so forty plays at the exact situation can stand for a smooth
 * distribution around them.
 */

export interface SmoothSettings {
  /**
   * How far a drawn gain is nudged, in yards. At zero the draw is a
   * past play exactly.
   */
  width: number;
  /**
   * Gains at or below this are left alone. A pass that gained nothing
   * is an incompletion and there are a great many of them, so
   * smoothing across that spike would invent completions for a yard
   * that never happened.
   */
  keepExactUpTo: number;
}

export const SMOOTH_OFF: SmoothSettings = { width: 0, keepExactUpTo: 0 };

/**
 * A gain drawn from the pool, nudged.
 *
 * The nudge is proportional to how far the play went, because the
 * gap between plays widens down the tail: there are hundreds of three
 * yard runs and a handful of fifty yard ones, so a fixed nudge would
 * be too coarse near the line and too fine out in the tail.
 */
export function nudge(
  gained: number, normal: () => number, settings: SmoothSettings,
): number {
  if (settings.width <= 0 || gained <= settings.keepExactUpTo) {
    return gained;
  }

  const spread = settings.width * Math.sqrt(Math.max(1, gained));

  return Math.max(1, Math.round(gained + normal() * spread));
}

/**
 * The read on a player in a few short phrases: whether he has been
 * missing games, how he has done against his line lately, whether his
 * role is moving, whether the weeks ahead are easier or harder than his
 * average, and what he projects against his draft spot. Each is said
 * only where it says something.
 */

import { ROLE_MOVE, type Work } from "./usage.ts";

export interface ReadChip {
  says: string;
  tone: "up" | "down" | "flat";
}

/** how many of his latest played weeks the form is read over */
const FORM_OVER = 3;

/** how far the weeks ahead have to sit from his average to say so */
const SCHEDULE_SAYS = 0.08;

/** how far over or under his draft spot is worth saying, a game */
const CLAIM_SAYS = 0.5;

export function readOf(input: {
  /** the weeks behind him, oldest first: what he scored, and his line */
  played: { got: number | null; pts: number }[];
  /** his lines for the weeks ahead, nearest first */
  next: number[];
  ppg?: number;
  work: { recent: Work; before: Work | null } | null;
  /** what he projects a game over his draft spot */
  claim?: number;
}): ReadChip[] {
  const chips: ReadChip[] = [];
  // the weeks he has missed most lately, which matter before anything else
  let missed = 0;

  for (let at = input.played.length - 1; at >= 0 && input.played[at]!.got === null; at--) {
    missed++;
  }

  if (missed > 0) {
    chips.push({ says: `out last ${missed === 1 ? "week" : `${missed} weeks`}`, tone: "down" });
  }

  const scored = input.played.filter((w) => w.got !== null).slice(-FORM_OVER);

  if (scored.length) {
    const over = scored.filter((w) => w.got! >= w.pts).length;
    const n = scored.length;

    if (n === 1) {
      chips.push(over
        ? { says: "over proj last week", tone: "up" }
        : { says: "under proj last week", tone: "down" });
    } else if (over === n) {
      chips.push({ says: `${n} straight over proj`, tone: "up" });
    } else if (over === 0) {
      chips.push({ says: `${n} straight under proj`, tone: "down" });
    } else {
      chips.push({ says: `${over} of last ${n} over proj`, tone: "flat" });
    }
  }

  if (input.work) {
    const now = Math.round(input.work.recent.snaps);
    const before = input.work.before ? Math.round(input.work.before.snaps) : null;

    if (before !== null && Math.abs(now - before) >= ROLE_MOVE) {
      chips.push(now > before
        ? { says: `snaps up ${before}→${now}%`, tone: "up" }
        : { says: `snaps down ${before}→${now}%`, tone: "down" });
    } else {
      chips.push({ says: `snaps steady ${now}%`, tone: "flat" });
    }
  }

  if (input.ppg && input.ppg > 0 && input.next.length >= 2) {
    const ahead = input.next.reduce((sum, pts) => sum + pts, 0) / input.next.length;

    if (ahead >= input.ppg * (1 + SCHEDULE_SAYS)) {
      chips.push({ says: "easier run ahead", tone: "up" });
    } else if (ahead <= input.ppg * (1 - SCHEDULE_SAYS)) {
      chips.push({ says: "tougher run ahead", tone: "down" });
    }
  }

  if (input.claim !== undefined && Math.abs(input.claim) >= CLAIM_SAYS) {
    chips.push(input.claim > 0
      ? { says: `+${input.claim.toFixed(1)}/g over draft spot`, tone: "up" }
      : { says: `${input.claim.toFixed(1)}/g under draft spot`, tone: "down" });
  }

  return chips;
}

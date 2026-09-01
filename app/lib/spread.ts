/**
 * A defence's week, drawn, because the board ships no spread for one.
 *
 * Everyone else arrives with five figures describing how his weeks
 * vary. A defence arrives with rates and nothing around them, so a card
 * had no range to draw and nothing could ask how his bad weeks looked.
 *
 * Draws are made from a fixed seed, so the same board gives the same
 * numbers every time the page is opened.
 */

import { payFor, type Parts, type Pays } from "./scoring.ts";

export interface Spread {
  ev: number;
  q1: number;
  mid: number;
  q3: number;
  low: number;
  high: number;
}

/** how many weeks to draw, enough that the quantiles stop moving */
export const DRAWS = 2000;

function mulberry32(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a name turned into a seed, so every player draws his own weeks */
function seedOf(name: string): number {
  let n = 2166136261;

  for (let i = 0; i < name.length; i++) {
    n = Math.imul(n ^ name.charCodeAt(i), 16777619);
  }

  return n >>> 0;
}

function poisson(rate: number, rand: () => number): number {
  if (rate <= 0) {
    return 0;
  }

  const limit = Math.exp(-rate);
  let n = 0;
  let product = rand();

  while (product > limit && n < 50) {
    n++;
    product *= rand();
  }

  return n;
}

/** the counting events a defence is paid for, none of them common */
const DEFENCE_EVENTS = ["sack", "int", "fum_rec", "def_td", "safe", "blk_kick"];

const BRACKETS = [
  "pts_allow_0", "pts_allow_1_6", "pts_allow_7_13", "pts_allow_14_20",
  "pts_allow_21_27", "pts_allow_28_34", "pts_allow_35p",
];

/**
 * A defence's weeks, built rather than read, because the board ships no
 * spread for one.
 *
 * Everything a defence is paid for is a rare event or a bracket. The
 * counts are drawn as rare events at the rate we expect, and how often
 * it held a side to each bracket already is a distribution over weeks,
 * so a week takes one bracket from it rather than a share of all seven.
 */
export function defenceWeeks(
  parts: Parts, pays: Pays, name: string, draws = DRAWS,
): number[] {
  const rand = mulberry32(seedOf(name));
  const weights = BRACKETS.map((at) => parts[at] ?? 0);
  const total = weights.reduce((sum, n) => sum + n, 0);
  const out: number[] = [];

  for (let i = 0; i < draws; i++) {
    const week: Parts = {};

    for (const event of DEFENCE_EVENTS) {
      week[event] = poisson(parts[event] ?? 0, rand);
    }

    if (total > 0) {
      let landed = rand() * total;
      let at = 0;

      while (at < BRACKETS.length - 1 && landed > weights[at]!) {
        landed -= weights[at]!;
        at++;
      }

      week[BRACKETS[at]!] = 1;
    }

    out.push(payFor(week, pays));
  }

  return out;
}

export function spreadOf(weeks: number[]): Spread {
  const sorted = [...weeks].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

  return {
    ev: sorted.reduce((sum, n) => sum + n, 0) / Math.max(1, sorted.length),
    low: at(0.1), q1: at(0.25), mid: at(0.5), q3: at(0.75), high: at(0.9),
  };
}


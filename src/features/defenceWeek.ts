/**
 * A defence's coming week, as parts a league can pay for itself.
 *
 * The board's defence number is last season divided by seventeen, which
 * says the same thing every week whatever the fixture. This projects a
 * week instead: the paid total comes off a fit on the defence's own
 * recent weeks, the sacks the other side gives up, and what the line
 * expects that side to score. The total is then handed back as rates
 * and as a chance of landing in each points-allowed bracket, so a
 * league with its own ladder pays it the way it pays the board.
 *
 * The weights come from the defenceWeekEval bench, fitted on the 2024
 * and 2025 weeks together. It reads 0.39 on ordering defences within a
 * week from week five on, where the board's number reads 0.04.
 */

import { poisson, seededRng } from "../sim/rng.js";

export type Parts = Record<string, number>;

export const DEFENCE_PARTS = [
  "sack", "int", "fum_rec", "def_td", "safe", "blk_kick",
];

/** what a defence is paid for where a league says nothing else */
export const STANDARD_DEFENCE_PAYS: Parts = {
  sack: 1, int: 2, fum_rec: 2, def_td: 6, safe: 2, blk_kick: 2,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};

/** each bracket and the most a side can score and still land in it */
const BRACKETS: [string, number][] = [
  ["pts_allow_0", 0],
  ["pts_allow_1_6", 6],
  ["pts_allow_7_13", 13],
  ["pts_allow_14_20", 20],
  ["pts_allow_21_27", 27],
  ["pts_allow_28_34", 34],
  ["pts_allow_35p", Infinity],
];

/** which bracket a side scoring this many points puts a defence in */
export function bracketOf(points: number): string {
  return (BRACKETS.find(([, upTo]) => points <= upTo) ??
    BRACKETS[BRACKETS.length - 1]!)[0];
}

const PAID_BASE = 11.6269;
const PAID_PER_OWN_RECENT = 0.1238;
const PAID_PER_OPP_SACK_ALLOWED = 0.797;
const PAID_PER_IMPLIED_AGAINST = -0.384;

const ALLOWED_BASE = -2.6065;
const ALLOWED_PER_IMPLIED = 1.1464;
const ALLOWED_SPREAD = 8.9093;

/** what a defence counted a game across 2024 and 2025 */
const LEAGUE_PARTS: Parts = {
  sack: 2.3732, int: 0.705, fum_rec: 0.4724, def_td: 0.0515,
  safe: 0.0248, blk_kick: 0.079,
};

/** how many of its own games a defence needs before its rates lead */
const SHRINK_GAMES = 6;

/** the most recent weeks of its own the paid fit reads */
export const TRAILING_WEEKS = 6;

/**
 * How far the counting rates may be moved to meet the paid total. A
 * week whose brackets and whose fit pull hard in opposite directions
 * would otherwise come back with three sacks or with none.
 */
const SCALE_BAND: [number, number] = [0.6, 1.5];

export interface DefenceWeekRead {
  /** its own paid weeks this season, oldest first */
  ownPaid: number[];
  /** its paid number a game last season, read until it has its own */
  lastYearPaid: number;
  /** its counting parts a game, over the weeks behind `ownGames` */
  ownParts: Parts;
  ownGames: number;
  /** sacks the other side has given up a game */
  oppSacksAllowed: number;
  /** what the line expects the other side to score */
  impliedAgainst: number;
}

export interface DefenceWeekLine {
  /** the counting rates and the chance of each bracket */
  parts: Parts;
  /** what those parts pay under the standard ladder */
  paid: number;
  /** the points the fit expects the other side to score */
  allowed: number;
}

const mean = (its: number[]) =>
  its.length ? its.reduce((sum, n) => sum + n, 0) / its.length : 0;

/** Abramowitz and Stegun 7.1.26, plenty for a bracket chance */
function normalBelow(x: number, centre: number, spread: number): number {
  const z = (x - centre) / (spread * Math.SQRT2);
  const sign = z < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const tail = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 +
    t * (-1.453152027 + t * 1.061405429))));
  const erf = sign * (1 - tail * Math.exp(-z * z));

  return 0.5 * (1 + erf);
}

/** the chance of each bracket, from where the line puts the other side */
function bracketChances(allowed: number): Parts {
  const out: Parts = {};
  let below = 0;

  for (const [bracket, upTo] of BRACKETS) {
    const under = upTo === Infinity
      ? 1
      : normalBelow(upTo + 0.5, allowed, ALLOWED_SPREAD);
    out[bracket] = Math.max(0, under - below);
    below = under;
  }

  return out;
}

export function payDefence(parts: Parts, pays: Parts): number {
  return Object.entries(parts)
    .reduce((sum, [part, n]) => sum + n * (pays[part] ?? 0), 0);
}

/**
 * The shape of the counting parts before they are scaled: its own rate
 * where it has games behind it, the league's where it does not, and
 * sacks moved by how freely the other side gives them up.
 */
function countingShape(read: DefenceWeekRead): Parts {
  const own = Math.min(1, read.ownGames / (read.ownGames + SHRINK_GAMES));
  const sackLift = LEAGUE_PARTS["sack"]!
    ? read.oppSacksAllowed / LEAGUE_PARTS["sack"]!
    : 1;
  const out: Parts = {};

  for (const part of DEFENCE_PARTS) {
    const league = LEAGUE_PARTS[part] ?? 0;
    const rate = own * (read.ownParts[part] ?? league) + (1 - own) * league;
    out[part] = part === "sack" ? rate * sackLift : rate;
  }

  return out;
}

/** a name turned into a seed, so every defence draws its own weeks */
export function seedOfName(name: string): number {
  let n = 2166136261;

  for (let i = 0; i < name.length; i++) {
    n = Math.imul(n ^ name.charCodeAt(i), 16777619);
  }

  return n >>> 0;
}

/**
 * A week's worth of weeks, so a floor and a ceiling can be read off
 * them. Every part is a rare event drawn at the rate we expect, and the
 * bracket chances are a distribution, so a week takes one bracket from
 * them rather than a share of all seven. The start/sit view draws the
 * board's defence the same way.
 */
export function drawDefenceWeeks(
  parts: Parts, pays: Parts, seed: number, draws = 2000,
): number[] {
  const rand = seededRng(seed);
  const weights = BRACKETS.map(([at]) => parts[at] ?? 0);
  const total = weights.reduce((sum, n) => sum + n, 0);
  const out: number[] = [];

  for (let i = 0; i < draws; i++) {
    const week: Parts = {};

    for (const part of DEFENCE_PARTS) {
      week[part] = poisson(parts[part] ?? 0, rand);
    }

    if (total > 0) {
      let landed = rand() * total;
      let at = 0;

      while (at < BRACKETS.length - 1 && landed > weights[at]!) {
        landed -= weights[at]!;
        at++;
      }

      week[BRACKETS[at]![0]] = 1;
    }

    out.push(payDefence(week, pays));
  }

  return out.sort((a, b) => a - b);
}

/** the quantile of a sorted set of drawn weeks */
export function drawnQuantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

export function projectDefenceWeek(read: DefenceWeekRead): DefenceWeekLine {
  const recent = read.ownPaid.slice(-TRAILING_WEEKS);
  const trailing = recent.length ? mean(recent) : read.lastYearPaid;
  const wanted = PAID_BASE +
    PAID_PER_OWN_RECENT * trailing +
    PAID_PER_OPP_SACK_ALLOWED * read.oppSacksAllowed +
    PAID_PER_IMPLIED_AGAINST * read.impliedAgainst;
  const allowed = ALLOWED_BASE + ALLOWED_PER_IMPLIED * read.impliedAgainst;
  const brackets = bracketChances(allowed);
  const shape = countingShape(read);
  const fromBrackets = payDefence(brackets, STANDARD_DEFENCE_PAYS);
  const fromCounting = payDefence(shape, STANDARD_DEFENCE_PAYS);
  const [least, most] = SCALE_BAND;
  const scale = fromCounting > 0
    ? Math.min(most, Math.max(least, (wanted - fromBrackets) / fromCounting))
    : 1;
  const parts: Parts = { ...brackets };

  for (const part of DEFENCE_PARTS) {
    parts[part] = Number(((shape[part] ?? 0) * scale).toFixed(4));
  }

  return {
    parts,
    paid: payDefence(parts, STANDARD_DEFENCE_PAYS),
    allowed,
  };
}

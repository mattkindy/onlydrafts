import { describe, expect, it } from "vitest";

import { normalAt, type From, type Mix } from "./copula.ts";
import {
  chanceWith, explainSwap, leadFor, worthExplaining,
  type Contender, type Seat,
} from "./explain.ts";
import {
  normalCdf, normalQuantile, normalStream, pointsOf, weekAt, type Spread,
} from "./spread.ts";

const DRAWS = 4000;

const factors = new Map<string, number[]>();

const factorAt: From = (seed, draws) => {
  let its = factors.get(seed);

  if (!its) {
    its = normalStream(seed, draws);
    factors.set(seed, its);
  }

  return its;
};

/** a week of this middle and this width, as the five shipped figures */
const ladder = (middle: number, width: number): Spread => ({
  ev: middle,
  mid: middle,
  low: middle + width * normalQuantile(0.1),
  q1: middle + width * normalQuantile(0.25),
  q3: middle + width * normalQuantile(0.75),
  high: middle + width * normalQuantile(0.9),
});

/** a man whose week is drawn the way a live week is, and his draws */
function man(
  name: string, middle: number, width: number,
  loads: [string, number][] = [],
): Contender {
  const spread = ladder(middle, width);
  const mix: Mix = {
    terms: loads.map(([factor, load]) => ({ factor, load })),
    own: Math.sqrt(Math.max(0, 1 - loads.reduce((s, [, l]) => s + l * l, 0))),
    ownSeed: `own|${name}`,
  };
  const points = pointsOf(spread);

  return {
    week: Array.from({ length: DRAWS }, (_, i) =>
      weekAt(points, normalCdf(normalAt(mix, i, DRAWS, factorAt)))),
    spread,
    mix,
    scored: 0,
    left: 1,
    pace: { played: 0, z: 0 },
  };
}

const flat = (points: number) =>
  new Array(DRAWS).fill(points) as number[];

const added = (base: number, men: Contender[]) =>
  Array.from({ length: DRAWS }, (_, i) =>
    men.reduce((sum, his) => sum + his.week[i]!, base));

const seatOf = (
  others: number[], theirs: number[],
  against: string[] = [], alongside: string[] = [],
): Seat => ({ others, theirs, factors: factorAt, against, alongside });

describe("a swap pulled apart", () => {
  /**
   * Their quarterback and my receiver play in the same game, so his week
   * and theirs move together, and mine is the only week that does.
   */
  it("prefers the lower projection when the other man shares their game", () => {
    const theirQb = man("theirs|qb", 22, 8, [["game|shared", 0.9]]);
    const seat = seatOf(flat(72), added(68, [theirQb]), ["game|shared"]);
    const inTheirGame = man("mine|shared", 15, 5, [["game|shared", 0.7]]);
    const elsewhere = man("mine|apart", 14, 5);
    const x = explainSwap(seat, inTheirGame, elsewhere);

    expect(x.projected.candidate).toBeLessThan(x.projected.starter);
    expect(x.gains).toBeGreaterThan(0);
    expect(x.points).toBeLessThan(0);
    expect(x.opponent).toBeGreaterThan(0);
    expect(x.opponent).toBeGreaterThan(Math.abs(x.points));
    expect(leadFor(x)).toContain("runs against the opponent's lineup");
  });

  /** you want the wider week when only a big afternoon gets you there */
  it("prefers the wider week as the underdog and the narrower as the favourite", () => {
    const steady = man("mine|steady", 15, 2);
    const wild = man("mine|wild", 15, 10);
    const theirs = added(0, [man("theirs|own", 20, 9)]);
    const behind = seatOf(flat(80), theirs.map((n) => n + 88));
    const ahead = seatOf(flat(80), theirs.map((n) => n + 64));
    const asUnderdog = explainSwap(behind, steady, wild);
    const asFavourite = explainSwap(ahead, steady, wild);

    expect(asUnderdog.odds).toBeLessThan(0.5);
    expect(asFavourite.odds).toBeGreaterThan(0.5);
    expect(Math.abs(asUnderdog.points)).toBeLessThan(0.01);
    expect(asUnderdog.spread).toBeGreaterThan(0.02);
    expect(asFavourite.spread).toBeLessThan(-0.02);
    expect(asUnderdog.gains).toBeGreaterThan(0);
    expect(asFavourite.gains).toBeLessThan(0);
    expect(leadFor(asUnderdog)).toContain("wider week");
    expect(leadFor(asFavourite)).toContain("narrower week");
  });

  it("gives back pieces that add up to the whole change", () => {
    const mine = man("mine|rest", 30, 7, [["game|both", 0.5]]);
    const seat = seatOf(
      added(40, [mine]),
      added(60, [man("theirs|own", 24, 9, [["game|both", 0.4]])]),
      ["game|both"], ["game|both"],
    );
    const x = explainSwap(
      seat,
      man("seated", 16, 6, [["game|both", 0.6]]),
      man("instead", 15, 9),
    );

    expect(x.points + x.spread + x.opponent + x.ownLineup)
      .toBeCloseTo(x.gains, 10);
  });

  /**
   * A man who shares nothing with anybody leaves the projection to do it
   * all, and the two correlation pieces come out at nought rather than
   * at whatever the drawing happened to leave in them.
   */
  it("puts everything in the points when neither man shares a game", () => {
    const seat = seatOf(added(70, [man("mine|rest", 30, 8)]),
      added(85, [man("theirs|own", 22, 9)]));
    const x = explainSwap(seat, man("one", 12, 6), man("two", 15, 6));

    expect(x.points).toBeGreaterThan(0.02);
    expect(x.opponent).toBe(0);
    expect(x.ownLineup).toBe(0);
    expect(x.spread).toBe(0);
  });

  it("prices the seat the same way whichever man is asked about", () => {
    const seated = man("one", 12, 6);
    const instead = man("two", 15, 6);
    const seat = seatOf(added(70, [man("mine|rest", 30, 8)]),
      added(85, [man("theirs|own", 22, 9)]));
    const x = explainSwap(seat, seated, instead);

    expect(chanceWith(seat, seated)).toBeCloseTo(x.odds, 12);
    expect(chanceWith(seat, instead) - chanceWith(seat, seated))
      .toBeCloseTo(x.gains, 12);
  });
});

describe("which swaps get a sentence", () => {
  it("keeps quiet where the projection already says it", () => {
    expect(worthExplaining(0.04, 3)).toBe(false);
    expect(worthExplaining(-0.04, -3)).toBe(false);
  });

  it("speaks up where the model disagrees with the projection", () => {
    expect(worthExplaining(0.04, -3)).toBe(true);
    expect(worthExplaining(-0.04, 3)).toBe(true);
  });

  it("speaks up on a close call and not on a swap worth nothing", () => {
    expect(worthExplaining(0.02, 0.8)).toBe(true);
    expect(worthExplaining(0.001, 0.8)).toBe(false);
  });
});

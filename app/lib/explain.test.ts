import { describe, expect, it } from "vitest";

import { explainSwap, leadFor, worthExplaining } from "./explain.ts";
import { normalStream } from "./spread.ts";

const DRAWS = 4000;

const noise = (seed: string) => normalStream(seed, DRAWS);

const combine = (parts: [number, number[]][], middle: number) =>
  Array.from({ length: DRAWS }, (_, i) =>
    middle + parts.reduce((sum, [load, its]) => sum + load * its[i]!, 0));

describe("a swap pulled apart", () => {
  /**
   * Their quarterback and my receiver play in the same game, so his week
   * and theirs move together, and mine is the only week that does.
   */
  it("prefers the lower projection when the other man shares their game", () => {
    const game = noise("game|shared");
    const theirQb = combine([[10, game]], 90);
    const myOtherStarters = combine([[8, noise("mine|rest")]], 60);
    const inTheirGame = combine([[7, game], [5, noise("own|shared")]], 15);
    const elsewhere = combine([[8.6, noise("own|apart")]], 14);
    const x = explainSwap({
      others: myOtherStarters,
      starter: inTheirGame,
      candidate: elsewhere,
      theirs: theirQb,
    });

    expect(x.projected.candidate).toBeLessThan(x.projected.starter);
    expect(x.gains).toBeGreaterThan(0);
    expect(x.points).toBeLessThan(0);
    expect(x.opponent).toBeGreaterThan(0);
    expect(x.opponent).toBeGreaterThan(Math.abs(x.points));
    expect(leadFor(x)).toContain("runs against the opponent's lineup");
  });

  /** the wider week is worth having when you need a big afternoon */
  it("prefers the wider week as the underdog and the narrower as the favourite", () => {
    const behind = 108;
    const ahead = 84;
    const myOtherStarters = combine([[8, noise("mine|rest")]], 80);
    const steady = combine([[3, noise("own|steady")]], 15);
    const wild = combine([[14, noise("own|wild")]], 15);
    const asUnderdog = explainSwap({
      others: myOtherStarters,
      starter: steady,
      candidate: wild,
      theirs: combine([[9, noise("theirs|own")]], behind),
    });
    const asFavourite = explainSwap({
      others: myOtherStarters,
      starter: steady,
      candidate: wild,
      theirs: combine([[9, noise("theirs|own")]], ahead),
    });

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
    const game = noise("game|both");
    const x = explainSwap({
      others: combine([[6, game], [7, noise("mine|rest")]], 70),
      starter: combine([[5, game], [6, noise("own|one")]], 16),
      candidate: combine([[9, noise("own|two")]], 15),
      theirs: combine([[4, game], [9, noise("theirs|own")]], 95),
    });

    expect(x.points + x.spread + x.opponent + x.ownLineup)
      .toBeCloseTo(x.gains, 10);
  });

  /**
   * A man who shares nothing with anybody leaves the projection to do it
   * all. The bounds are a couple of points of win chance wide because
   * breaking a tie re-counts on different draws, and counting four
   * thousand of them is worth about that much on its own.
   */
  it("puts nearly everything in the points when neither man shares a game", () => {
    const x = explainSwap({
      others: combine([[8, noise("mine|rest")]], 70),
      starter: combine([[6, noise("own|one")]], 12),
      candidate: combine([[6, noise("own|two")]], 15),
      theirs: combine([[9, noise("theirs|own")]], 85),
    });

    expect(x.points).toBeGreaterThan(0.02);
    expect(Math.abs(x.opponent)).toBeLessThan(0.02);
    expect(Math.abs(x.ownLineup)).toBeLessThan(0.02);
    expect(Math.abs(x.spread)).toBeLessThan(0.02);
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

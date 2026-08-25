import { describe, expect, it } from "vitest";
import {
  projectFromMechanics, settle, KEEPS,
  type League, type Receiving, type Running,
} from "./mechanicsProjection.js";

const league: League = {
  receiving: {
    targets: 85, receptions: 55, beforeCatch: 420, afterCatch: 240, drops: 4,
  },
  running: { carries: 120, beforeContact: 350, afterContact: 200 },
};

const noRunning: Running = {
  games: 17, carries: 0, beforeContact: 0, afterContact: 0,
};

const receiver = (over: Partial<Receiving> = {}): Receiving => ({
  games: 17, targets: 120, receptions: 80,
  beforeCatch: 640, afterCatch: 400, drops: 5, ...over,
});

describe("pulling one part back toward the league", () => {
  it("leaves a man at the league when he is the league", () => {
    expect(settle("beforeCatch", 8, 8, 200, 70)).toBeCloseTo(8, 10);
  });

  it("keeps more of a steady part than a fickle one", () => {
    const steady = settle("beforeCatch", 12, 8, 1e9, 70);
    const fickle = settle("dropShare", 12, 8, 1e9, 70);

    expect(steady - 8).toBeGreaterThan(fickle - 8);
    expect(steady - 8).toBeCloseTo(4 * KEEPS.beforeCatch, 6);
  });

  it("trusts a thin season less than a full one", () => {
    const thin = settle("targetsPerGame", 10, 5, 20, 70);
    const full = settle("targetsPerGame", 10, 5, 200, 70);

    expect(thin).toBeLessThan(full);
    expect(thin).toBeGreaterThan(5);
  });

  it("falls back to the league when he has no number at all", () => {
    expect(settle("afterCatch", NaN, 4.5, 100, 70)).toBe(4.5);
  });
});

describe("a season built from the parts", () => {
  it("adds a catch up as how far the ball went plus how far he took it", () => {
    const said = projectFromMechanics(receiver(), noRunning, league);

    expect(said.recYds).toBeCloseTo(
      said.receptions * (said.beforeCatch + said.afterCatch), 8,
    );
  });

  it("gives a man thrown at more the more catches", () => {
    const busy = projectFromMechanics(receiver({ targets: 160, receptions: 105 }),
      noRunning, league);
    const quiet = projectFromMechanics(receiver({ targets: 60, receptions: 40 }),
      noRunning, league);

    expect(busy.targetsPerGame).toBeGreaterThan(quiet.targetsPerGame);
    expect(busy.recYds).toBeGreaterThan(quiet.recYds);
  });

  it("keeps a deep man deep and a short one short", () => {
    const deep = projectFromMechanics(receiver({ beforeCatch: 1200 }), noRunning, league);
    const short = projectFromMechanics(receiver({ beforeCatch: 240 }), noRunning, league);

    expect(deep.beforeCatch).toBeGreaterThan(short.beforeCatch + 4);
  });

  /**
   * A receiver who played a season and never carried it is not an
   * unknown quantity, and giving him a back's carries because he has
   * none of his own is how the league average leaks into everybody.
   */
  it("does not hand a man carries because he has never had any", () => {
    // his own position group, where nobody runs it much either
    const receivers: League = {
      ...league,
      running: { carries: 5, beforeContact: 14, afterContact: 8 },
    };
    const said = projectFromMechanics(receiver(), noRunning, receivers);

    expect(said.carriesPerGame).toBeLessThan(0.3);
    expect(said.rushYds).toBeLessThan(2);
  });

  it("falls back to the league for a man with no season at all", () => {
    const nobody = projectFromMechanics(
      { games: 0, targets: 0, receptions: 0, beforeCatch: 0, afterCatch: 0, drops: 0 },
      { games: 0, carries: 0, beforeContact: 0, afterContact: 0 },
      league,
    );

    for (const value of Object.values(nobody)) {
      expect(Number.isFinite(value)).toBe(true);
    }

    expect(nobody.recYds).toBeGreaterThan(0);
  });

  it("never returns something that is not a number", () => {
    const said = projectFromMechanics(receiver({ receptions: 0 }), noRunning, league);

    for (const value of Object.values(said)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

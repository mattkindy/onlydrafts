import { describe, expect, it } from "vitest";
import { advance, emptyState, observe, DEFAULTS } from "./dynamicPlusMinus.js";
import type { Snap } from "./plusMinus.js";
import { seededRng } from "../sim/rng.js";

/** a week of snaps drawn from whatever each man is actually worth now */
function week(truth: Map<string, number>, rng: () => number, count: number): Snap[] {
  const ids = [...truth.keys()];
  const snaps: Snap[] = [];

  for (let i = 0; i < count; i++) {
    const order = [...ids].sort(() => rng() - 0.5);
    const forIt = order.slice(0, 5);
    const against = order.slice(5, 10);
    const signal =
      forIt.reduce((s, id) => s + truth.get(id)!, 0) -
      against.reduce((s, id) => s + truth.get(id)!, 0);
    snaps.push({ forIt, against, outcome: 0.7 + signal + (rng() - 0.5) * 0.5 });
  }

  return snaps;
}

const CAST = ["star", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
const flat = () => new Map(CAST.map((id) => [id, id === "star" ? 0.08 : 0]));

function run(
  weeks: number,
  truthAt: (w: number) => Map<string, number>,
  outAt: (w: number) => boolean,
  seed = 4,
) {
  const rng = seededRng(seed);
  let state = emptyState(0.7);
  const history: { mean: number; variance: number }[] = [];

  for (let w = 0; w < weeks; w++) {
    const truth = truthAt(w);
    const out = outAt(w);
    const cast = out ? CAST.filter((id) => id !== "star") : CAST;
    const playing = new Map(cast.map((id) => [id, truth.get(id)!]));
    state = advance(state, new Set(cast));
    state = observe(state, week(playing, rng, 900));
    const belief = state.players.get("star") ?? { mean: 0, variance: DEFAULTS.priorVariance };
    history.push({ ...belief });
  }

  return history;
}

describe("a player who keeps playing", () => {
  const history = run(14, flat, () => false);

  it("is found to be good", () => {
    expect(history.at(-1)!.mean).toBeGreaterThan(0.05);
  });

  it("is pinned down more tightly as the weeks pass", () => {
    expect(history.at(-1)!.variance).toBeLessThan(history[1]!.variance);
  });
});

describe("a player who misses six weeks", () => {
  const out = (w: number) => w >= 6 && w < 12;
  const history = run(18, flat, out);

  it("keeps his estimate while he is out", () => {
    expect(history[11]!.mean).toBeCloseTo(history[5]!.mean, 2);
  });

  it("is less certain by the time he comes back", () => {
    expect(history[11]!.variance).toBeGreaterThan(history[5]!.variance);
  });

  it("is pinned down again once he plays", () => {
    expect(history[14]!.variance).toBeLessThan(history[11]!.variance);
  });
});

describe("a player who comes back diminished", () => {
  // nothing in the model is told about this; the snaps have to say it
  const truthAt = (w: number) => {
    const truth = flat();
    if (w >= 12) truth.set("star", 0.01);
    return truth;
  };
  const history = run(18, truthAt, (w) => w >= 6 && w < 12);

  it("is marked down within a couple of weeks of returning", () => {
    expect(history[14]!.mean).toBeLessThan(history[5]!.mean - 0.02);
  });

  it("lands near what he is now worth rather than what he was", () => {
    expect(history.at(-1)!.mean).toBeLessThan(0.045);
  });

  it("moves faster than a man who never left would have", () => {
    const neverLeft = run(18, truthAt, () => false);
    const dropAfterReturn = history[5]!.mean - history[13]!.mean;
    const dropWithoutBreak = neverLeft[11]!.mean - neverLeft[13]!.mean;

    expect(dropAfterReturn).toBeGreaterThan(dropWithoutBreak);
  });
});

describe("a player who comes back fine", () => {
  const history = run(18, flat, (w) => w >= 6 && w < 12);

  it("is not marked down for having been hurt", () => {
    expect(history.at(-1)!.mean).toBeGreaterThan(0.05);
  });
});

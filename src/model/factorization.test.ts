import { describe, expect, it } from "vitest";
import {
  FIT_DEFAULTS, affinity, fitFactorization, predict, type Example,
} from "./factorization.js";

/**
 * Build plays where the answer depends on a combination nobody names,
 * and check the fit finds it. Two coaches, two quarterbacks, and the
 * yards depend on the pairing rather than on either alone.
 */
function pairedWorld(count: number): Example[] {
  const examples: Example[] = [];
  const coaches = ["coach:vertical", "coach:westCoast"];
  const passers = ["passer:deep", "passer:checkdown"];

  for (let i = 0; i < count; i++) {
    const coach = coaches[i % 2]!;
    const passer = passers[Math.floor(i / 2) % 2]!;
    // each alone averages the same; together they do not
    const suits = (coach === "coach:vertical") === (passer === "passer:deep");
    examples.push({
      features: [coach, passer, "down:1"],
      target: (suits ? 8 : 2) + ((i % 7) - 3) * 0.2,
    });
  }

  return examples;
}

describe("finding a combination nobody named", () => {
  const model = fitFactorization(pairedWorld(6000), { ...FIT_DEFAULTS, passes: 20 });

  it("predicts the pairing that suits above the one that does not", () => {
    const suits = predict(model, ["coach:vertical", "passer:deep", "down:1"]);
    const clashes = predict(model, ["coach:vertical", "passer:checkdown", "down:1"]);

    expect(suits).toBeGreaterThan(clashes + 3);
  });

  it("gets both good pairings right, not only one", () => {
    const other = predict(model, ["coach:westCoast", "passer:checkdown", "down:1"]);
    const clashes = predict(model, ["coach:westCoast", "passer:deep", "down:1"]);

    expect(other).toBeGreaterThan(clashes + 3);
  });

  it("shows the pairing as a pull between their vectors", () => {
    expect(affinity(model, "coach:vertical", "passer:deep"))
      .toBeGreaterThan(affinity(model, "coach:vertical", "passer:checkdown"));
  });

  it("lands near the right numbers, not only the right order", () => {
    expect(predict(model, ["coach:vertical", "passer:deep", "down:1"]))
      .toBeGreaterThan(6);
    expect(predict(model, ["coach:vertical", "passer:checkdown", "down:1"]))
      .toBeLessThan(4);
  });
});

describe("a world where nothing interacts", () => {
  const examples: Example[] = [];

  for (let i = 0; i < 4000; i++) {
    const good = i % 2 === 0;
    examples.push({
      features: [good ? "team:good" : "team:poor", "down:1"],
      target: (good ? 7 : 3) + ((i % 5) - 2) * 0.1,
    });
  }

  const model = fitFactorization(examples, { ...FIT_DEFAULTS, passes: 20 });

  it("still separates them, on the plain pull alone", () => {
    expect(predict(model, ["team:good", "down:1"]))
      .toBeGreaterThan(predict(model, ["team:poor", "down:1"]) + 2);
  });
});

describe("repeatability", () => {
  it("gives the same fit twice from the same seed", () => {
    const world = pairedWorld(500);
    const a = fitFactorization(world, { ...FIT_DEFAULTS, passes: 3 });
    const b = fitFactorization(world, { ...FIT_DEFAULTS, passes: 3 });

    expect(predict(a, ["coach:vertical", "passer:deep", "down:1"]))
      .toBeCloseTo(predict(b, ["coach:vertical", "passer:deep", "down:1"]), 10);
  });
});

describe("when a fit runs away", () => {
  it("says so rather than handing back nonsense", () => {
    const wild = Array.from({ length: 200 }, (_, i) => ({
      features: [`team:${i % 3}`, "down:1"],
      target: i % 2 === 0 ? 1e6 : -1e6,
    }));

    expect(() => fitFactorization(wild, { ...FIT_DEFAULTS, rate: 50 }))
      .toThrow(/ran away/);
  });
});

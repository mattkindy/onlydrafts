import { describe, expect, it } from "vitest";
import { NET_DEFAULTS, fitEntityNet, predict, type Task } from "./entityNet.js";

/**
 * A world where the answer depends on three things together, which is
 * what a pairwise model cannot represent and this one should.
 */
function threeWayWorld(count: number) {
  const plays: string[][] = [];
  const yards: number[] = [];
  const runs: number[] = [];

  for (let i = 0; i < count; i++) {
    const coach = i % 2 === 0 ? "coach:bold" : "coach:careful";
    const set = Math.floor(i / 2) % 2 === 0 ? "set:heavy" : "set:spread";
    const spot = Math.floor(i / 4) % 2 === 0 ? "spot:goalLine" : "spot:midfield";
    plays.push([coach, set, spot]);

    // only the bold coach, heavy, at the goal line does anything
    const rare = coach === "coach:bold" && set === "set:heavy" && spot === "spot:goalLine";
    yards.push((rare ? 9 : 3) + ((i % 5) - 2) * 0.15);
    // a second question the same vectors have to answer
    runs.push(set === "set:heavy" ? 1 : 0);
  }

  return { plays, yards, runs };
}

describe("a description trained on several questions", () => {
  const world = threeWayWorld(8000);
  const tasks: Task[] = [
    { name: "yards", of: (i) => world.yards[i] },
    { name: "run", of: (i) => world.runs[i] },
  ];
  const net = fitEntityNet(world.plays, tasks, { ...NET_DEFAULTS, passes: 25 });

  it("finds a combination of three that no pair explains", () => {
    const rare = predict(net, ["coach:bold", "set:heavy", "spot:goalLine"], "yards");
    const swapCoach = predict(net, ["coach:careful", "set:heavy", "spot:goalLine"], "yards");
    const swapSpot = predict(net, ["coach:bold", "set:heavy", "spot:midfield"], "yards");

    expect(rare).toBeGreaterThan(swapCoach + 2);
    expect(rare).toBeGreaterThan(swapSpot + 2);
  });

  it("answers the other question from the same vectors", () => {
    expect(predict(net, ["coach:bold", "set:heavy", "spot:midfield"], "run"))
      .toBeGreaterThan(predict(net, ["coach:bold", "set:spread", "spot:midfield"], "run") + 0.4);
  });

  it("keeps every entity's description the same length", () => {
    for (const vector of net.vector.values()) {
      expect(vector.length).toBe(NET_DEFAULTS.width);
    }
  });

  it("takes a question that only some plays answer", () => {
    const sparse: Task[] = [
      { name: "yards", of: (i) => world.yards[i] },
      { name: "rare", of: (i) => (i % 10 === 0 ? world.runs[i] : undefined) },
    ];

    expect(() => fitEntityNet(world.plays.slice(0, 400), sparse, {
      ...NET_DEFAULTS, passes: 2,
    })).not.toThrow();
  });

  it("stays finite even on targets that would blow up a linear fit", () => {
    // the squashed hidden layer and the clipped error between them
    // stop this running to infinity, which the factorized model did
    const wild = Array.from({ length: 200 }, (_, i) => [`team:${i % 3}`]);
    const blowUp: Task[] = [
      { name: "yards", of: (i) => (i % 2 === 0 ? 1e6 : -1e6) },
    ];
    const net = fitEntityNet(wild, blowUp, { ...NET_DEFAULTS, rate: 500 });

    expect(Number.isFinite(predict(net, ["team:0"], "yards"))).toBe(true);
  });

  it("repeats exactly from the same seed", () => {
    const again = fitEntityNet(world.plays, tasks, { ...NET_DEFAULTS, passes: 3 });
    const once = fitEntityNet(world.plays, tasks, { ...NET_DEFAULTS, passes: 3 });

    expect(predict(again, ["coach:bold", "set:heavy", "spot:goalLine"], "yards"))
      .toBeCloseTo(predict(once, ["coach:bold", "set:heavy", "spot:goalLine"], "yards"), 10);
  });
});

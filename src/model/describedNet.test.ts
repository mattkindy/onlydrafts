import { describe, expect, it } from "vitest";
import {
  DESCRIBED_DEFAULTS, fitDescribedNet, predict,
  type Described, type Task,
} from "./describedNet.js";

const player = (speed: number, weight: number): Described =>
  ({ kind: "player", values: Float64Array.from([speed, weight]) });
const spot = (deep: number): Described =>
  ({ kind: "situation", values: Float64Array.from([deep]) });

/**
 * A world where fast light players do well deep and heavy ones do well
 * near the line. Nothing names either rule, and the model never sees
 * an identity, only the numbers.
 */
function world(count: number, random: () => number) {
  const plays: Described[][] = [];
  const yards: number[] = [];

  for (let i = 0; i < count; i++) {
    const speed = random() * 2 - 1;
    const weight = random() * 2 - 1;
    const deep = i % 2 === 0 ? 1 : -1;
    plays.push([player(speed, weight), spot(deep)]);
    yards.push(deep > 0 ? 6 + speed * 4 - weight * 2 : 4 - speed * 2 + weight * 3);
  }

  return { plays, yards };
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("a network fed descriptions", () => {
  const { plays, yards } = world(6000, seeded(3));
  const tasks: Task[] = [{ name: "yards", of: (i) => yards[i] }];
  const net = fitDescribedNet(plays, tasks, { ...DESCRIBED_DEFAULTS, passes: 25 });

  it("learns that speed pays deep", () => {
    const fast = predict(net, [player(1, 0), spot(1)], "yards");
    const slow = predict(net, [player(-1, 0), spot(1)], "yards");

    expect(fast).toBeGreaterThan(slow + 2);
  });

  it("learns that weight pays near the line", () => {
    const heavy = predict(net, [player(0, 1), spot(-1)], "yards");
    const light = predict(net, [player(0, -1), spot(-1)], "yards");

    expect(heavy).toBeGreaterThan(light + 2);
  });

  it("answers for a man it has never seen", () => {
    // no identity anywhere, so a new description projects the same way
    const stranger = predict(net, [player(0.9, -0.8), spot(1)], "yards");

    expect(Number.isFinite(stranger)).toBe(true);
    expect(stranger).toBeGreaterThan(predict(net, [player(-0.9, 0.8), spot(1)], "yards"));
  });

  it("keeps one projection per kind of entity, not one per entity", () => {
    expect([...net.project.keys()].sort()).toEqual(["player", "situation"]);
    expect(net.project.get("player")!.length).toBe(2);
  });

  it("repeats exactly from the same seed", () => {
    const again = fitDescribedNet(plays, tasks, { ...DESCRIBED_DEFAULTS, passes: 3 });
    const once = fitDescribedNet(plays, tasks, { ...DESCRIBED_DEFAULTS, passes: 3 });

    expect(predict(again, [player(1, 0), spot(1)], "yards"))
      .toBeCloseTo(predict(once, [player(1, 0), spot(1)], "yards"), 10);
  });
});

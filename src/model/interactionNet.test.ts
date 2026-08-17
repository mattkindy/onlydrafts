import { describe, expect, it } from "vitest";
import {
  DESCRIBED_DEFAULTS, fitDescribedNet, predict as predictPooled,
} from "./describedNet.js";
import {
  INTERACTION_DEFAULTS, fitInteractionNet, predict, type Described,
} from "./interactionNet.js";

/**
 * Two entities, each either up or down, and the answer is whether they
 * agree. Averaging them destroys that: up with down and down with up
 * both average to nothing, so no amount of hidden units applied after
 * the average can separate the two cases.
 */
function agreementPlays(count: number) {
  const plays: Described[][] = [];
  const answers: number[] = [];

  for (let i = 0; i < count; i++) {
    const a = i % 2 === 0 ? 1 : -1;
    const b = Math.floor(i / 2) % 2 === 0 ? 1 : -1;
    plays.push([
      { kind: "a", values: Float64Array.from([a]) },
      { kind: "b", values: Float64Array.from([b]) },
    ]);
    answers.push(a * b);
  }

  return { plays, answers };
}

describe("interactionNet", () => {
  it("learns that two entities agree, which pooling cannot express", () => {
    const { plays, answers } = agreementPlays(400);
    const task = [{ name: "agree", of: (i: number) => answers[i] }];

    const net = fitInteractionNet(plays, task, {
      ...INTERACTION_DEFAULTS, width: 4, hidden: 12, passes: 40, rate: 0.05,
    });
    const pooled = fitDescribedNet(plays, task, {
      ...DESCRIBED_DEFAULTS, width: 4, hidden: 12, passes: 40, rate: 0.05,
    });

    const errorOf = (said: (on: Described[]) => number) =>
      Math.sqrt(
        plays.reduce((sum, on, i) => sum + (said(on) - answers[i]!) ** 2, 0) /
          plays.length,
      );

    const withProducts = errorOf((on) => predict(net, on, "agree"));
    const withoutProducts = errorOf((on) => predictPooled(pooled, on, "agree"));

    // pooling can do no better than guessing the average, which on a
    // target of plus and minus one is an error of one
    expect(withoutProducts).toBeGreaterThan(0.9);
    expect(withProducts).toBeLessThan(0.5);
  });

  it("stays finite on values far outside the range it was fitted on", () => {
    const { plays, answers } = agreementPlays(200);
    const net = fitInteractionNet(
      plays, [{ name: "agree", of: (i: number) => answers[i] }],
      { ...INTERACTION_DEFAULTS, passes: 5 },
    );
    const said = predict(net, [
      { kind: "a", values: Float64Array.from([50]) },
      { kind: "b", values: Float64Array.from([-50]) },
    ], "agree");

    expect(Number.isFinite(said)).toBe(true);
  });
});

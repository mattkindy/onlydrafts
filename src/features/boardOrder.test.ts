import { describe, expect, it } from "vitest";
import {
  blendedPlace, leanFor, placesBy, BOARD_LEAN, QB_LEAN,
} from "./boardOrder.js";

describe("blendedPlace", () => {
  it("puts a man the three agree on where they all had him", () => {
    expect(blendedPlace({ model: 10, share: 10, adp: 10 })).toBeCloseTo(10);
  });

  it("gives adp half the say and the two models the other half", () => {
    const adpLikesHim = blendedPlace({ model: 50, share: 50, adp: 10 });
    const theModelsLikeHim = blendedPlace({ model: 10, share: 10, adp: 50 });

    expect(adpLikesHim).toBeCloseTo(theModelsLikeHim);
  });

  it("leans on the share model more than on the regression", () => {
    const shareLikesHim = blendedPlace({ model: 50, share: 10, adp: 30 });
    const theRegressionLikesHim = blendedPlace({ model: 10, share: 50, adp: 30 });

    expect(shareLikesHim).toBeLessThan(theRegressionLikesHim);
  });

  it("gives a silent opinion's weight to the ones that spoke", () => {
    // a quarterback, whom the share model has nothing to say about:
    // his place is the weighted middle of the opinions that spoke
    const spoke = BOARD_LEAN.model + BOARD_LEAN.adp;
    expect(blendedPlace({ model: 20, adp: 40 })).toBeCloseTo(
      (BOARD_LEAN.model * 20 + BOARD_LEAN.adp * 40) / spoke,
    );
  });

  it("leaves a man nobody priced where the models put him", () => {
    expect(blendedPlace({ model: 30, share: 30 })).toBeCloseTo(30);
  });
});

describe("leanFor", () => {
  it("orders a quarterback mostly by the walk", () => {
    const place = blendedPlace(
      { model: 30, adp: 30, walk: 10 }, leanFor("QB"),
    );
    const spoke = QB_LEAN.model + QB_LEAN.adp + QB_LEAN.walk;

    expect(place).toBeCloseTo(
      (QB_LEAN.walk * 10 + (QB_LEAN.model + QB_LEAN.adp) * 30) / spoke,
    );
  });

  it("leaves everyone else on the board's lean", () => {
    expect(leanFor("RB")).toBe(BOARD_LEAN);
  });
});

describe("placesBy", () => {
  it("numbers the best man first and leaves out the ones without one", () => {
    const places = placesBy(
      [
        { id: "best", touches: 300 },
        { id: "next", touches: 200 },
        { id: "unknown", touches: null },
      ],
      (man) => man.id,
      (man) => man.touches,
    );

    expect(places.get("best")).toBe(1);
    expect(places.get("next")).toBe(2);
    expect(places.has("unknown")).toBe(false);
  });
});

/**
 * Each opinion ranks only the men it can see, and it sees a different
 * set. Adp prices the top 200 or so, which is roughly the front of the
 * board, and its places line up with the board's. An opinion that
 * covers scattered men does not: rank 250 of 440 can be the 400th man
 * on a board of 740, and the blend reads 250 and pulls him forward.
 */
describe("an opinion that speaks for only some of the board", () => {
  /** a board where every other man is missing from one opinion */
  const board = Array.from({ length: 20 }, (_, i) => ({
    key: `m${i}`,
    /** best first, so a higher number is a better man */
    worth: 20 - i,
    seen: i % 2 === 0,
  }));

  it("compresses a man's place toward the front when it skips men", () => {
    const everyone = placesBy(board, (m) => m.key, (m) => m.worth);
    const everyOther = placesBy(
      board, (m) => m.key, (m) => (m.seen ? m.worth : null),
    );
    const him = "m14";

    expect(everyone.get(him)).toBe(15);
    // the same man, eighth of the ten it can see
    expect(everyOther.get(him)).toBe(8);
  });

  /**
   * This is what put an undrafted quarterback ninth: his parts model
   * spoke for 443 of 740, so its places ran short and everyone it
   * spoke for came forward against the opinions that ran long.
   */
  it("is why two opinions cannot have their places added as they are", () => {
    const everyone = placesBy(board, (m) => m.key, (m) => m.worth);
    const everyOther = placesBy(
      board, (m) => m.key, (m) => (m.seen ? m.worth : null),
    );
    const him = "m14";

    expect(everyOther.get(him)!).toBeLessThan(everyone.get(him)!);
    // how far down each list he is agrees to within one man, which is
    // the number the blend should be given instead of the place
    expect(Math.abs(
      everyOther.get(him)! / everyOther.size -
      everyone.get(him)! / everyone.size,
    )).toBeLessThan(1 / everyOther.size);
  });

  it("ranks nobody it cannot see", () => {
    const said = placesBy(
      [{ k: "a", v: 3 }, { k: "b", v: null }, { k: "c", v: 1 }],
      (m) => m.k, (m) => m.v,
    );

    expect(said.has("b")).toBe(false);
    expect(said.size).toBe(2);
  });
});

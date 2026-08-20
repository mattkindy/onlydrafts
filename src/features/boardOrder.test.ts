import { describe, expect, it } from "vitest";
import { blendedPlace, placesBy, BOARD_LEAN } from "./boardOrder.js";

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

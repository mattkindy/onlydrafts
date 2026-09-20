import { describe, expect, it } from "vitest";
import {
  kickingVenue, makeKickingVenue, SHIPPED_TABLES, type Venue,
} from "./kickingVenue.js";

const mild: Venue = { indoors: false, temperature: 60, wind: 4 };
const freezing: Venue = { indoors: false, temperature: 25, wind: 4 };
const cold: Venue = { indoors: false, temperature: 36, wind: 4 };
const snowing: Venue = { ...freezing, precipitation: 3, snowfall: 2 };
const raining: Venue = { ...mild, precipitation: 3 };
const drizzling: Venue = { ...mild, precipitation: 0.3 };

/** a fifty yarder, since the bands only separate at range */
const LONG = 50 - 17;

describe("what the ground does to a kick", () => {
  it("leaves a mild afternoon exactly alone", () => {
    expect(kickingVenue.bend(LONG, mild)).toBeCloseTo(1, 10);
    expect(kickingVenue.appetite(mild)).toBeCloseTo(1, 10);
  });

  it("splits freezing from merely cold on how often he is sent out", () => {
    const atFreezing = kickingVenue.appetite(freezing);
    const atCold = kickingVenue.appetite(cold);

    expect(atFreezing).toBeLessThan(atCold);
    expect(atCold).toBeLessThan(1);
  });

  it("sends him out least of all in the snow", () => {
    expect(kickingVenue.appetite(snowing))
      .toBeLessThan(kickingVenue.appetite(freezing));
  });

  it("barely moves for rain on its own, which is what the kicks said", () => {
    expect(kickingVenue.appetite(raining)).toBeGreaterThan(0.98);
    expect(kickingVenue.appetite(raining)).toBeLessThan(1);
  });

  it("calls a drizzle dry, since a millimetre is where the cut is", () => {
    expect(kickingVenue.appetite(drizzling)).toBeCloseTo(1, 10);
  });

  it("counts rain below freezing as snow even with no snowfall given", () => {
    const sleet: Venue = { indoors: false, temperature: 25, precipitation: 3 };

    expect(kickingVenue.appetite(sleet))
      .toBeCloseTo(kickingVenue.appetite(snowing), 10);
  });

  it("takes the weather out of a game played under a roof", () => {
    const inside: Venue = {
      indoors: true, temperature: 10, wind: 40, precipitation: 9, snowfall: 5,
    };

    expect(kickingVenue.bend(LONG, inside))
      .toBeCloseTo(kickingVenue.bend(LONG, { indoors: true }), 10);
    expect(kickingVenue.appetite(inside)).toBeGreaterThan(1);
  });

  /**
   * A staff only tries a long one in a gale when they fancy it, so the
   * attempts that happen are the easy ones and the rate reads high.
   */
  it("never lets wind move the kick itself, only the choice", () => {
    const gale: Venue = { indoors: false, temperature: 60, wind: 30 };

    expect(kickingVenue.bend(LONG, gale)).toBeCloseTo(1, 10);
    expect(kickingVenue.extraPoint(gale))
      .toBeCloseTo(kickingVenue.extraPoint(mild), 10);
    expect(kickingVenue.appetite(gale)).toBeLessThan(1);
  });

  it("reads a ground with nothing recorded as a mild afternoon", () => {
    expect(kickingVenue.appetite({ indoors: false })).toBeCloseTo(1, 10);
    expect(kickingVenue.bend(LONG, { indoors: false })).toBeCloseTo(1, 10);
  });

  it("scores a rival set of tables through the same reader", () => {
    const harsher = makeKickingVenue({
      ...SHIPPED_TABLES,
      sentOut: { ...SHIPPED_TABLES.sentOut, snow: 0.3 },
    });

    expect(harsher.appetite(snowing))
      .toBeLessThan(kickingVenue.appetite(snowing));
    expect(harsher.appetite(mild)).toBeCloseTo(1, 10);
  });
});

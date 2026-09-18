import { describe, expect, it } from "vitest";
import { fitUnaimed } from "./fitUnaimed.js";
import type { PlayRow } from "./fitPlayFactors.js";

const aThrow = (player: string, yards: number, down = 1): PlayRow => ({
  offence: "NE", defence: "NYJ", down, toGo: 10, yardline: 60,
  margin: 0, secondsLeft: 1800, call: "pass", yards, touchdown: 0,
  player, caught: yards > 0,
});

/** a stream that walks the unit interval, so a rate can be read off it */
const stepping = (values: number[]) => {
  let at = 0;

  return () => values[at++ % values.length]!;
};

describe("the throws that reach nobody", () => {
  /**
   * A thousand failed throws, a tenth of them reaching nobody, and six
   * of every ten of those a sack. The catches ride along to be ignored.
   */
  const rows: PlayRow[] = [];

  for (let i = 0; i < 1000; i++) {
    const nobody = i % 10 === 0;
    rows.push(nobody
      ? aThrow("", i % 100 < 60 ? -7 : 0)
      : aThrow("Diggs", 0));
    rows.push(aThrow("Diggs", 9));
  }

  it("finds the rate the plays came out at", () => {
    const unaimed = fitUnaimed(rows);

    expect(unaimed.reaches(1, stepping([0.05]))).toBeDefined();
    expect(unaimed.reaches(1, stepping([0.5]))).toBeUndefined();
  });

  it("charges a sack the yards a sack cost", () => {
    const unaimed = fitUnaimed(rows);
    const sacked = unaimed.reaches(1, stepping([0.01, 0.01]));

    expect(sacked).toEqual({ yards: -7, sack: true });
  });

  it("leaves a ball thrown away at nothing", () => {
    const thrownAway = fitUnaimed(rows).reaches(1, stepping([0.01, 0.99]));

    expect(thrownAway).toEqual({ yards: 0, sack: false });
  });

  it("speaks for a down nobody threw on", () => {
    expect(fitUnaimed(rows).reaches(4, stepping([0.01, 0.01]))?.sack)
      .toBe(true);
  });
});

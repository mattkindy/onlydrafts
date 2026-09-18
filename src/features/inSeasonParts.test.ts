import { describe, expect, it } from "vitest";
import { partsAtLevel, pointsOfLine, updateParts } from "./inSeasonParts.js";
import { blankParts } from "./partsModel.js";
import type { StatParts } from "./seasonSummary.js";
import type { UsagePerGame } from "./inSeasonLevel.js";

/** a receiver's preseason game: eight targets, five catches, seventy yards */
function anchor(): StatParts {
  return {
    ...blankParts(),
    receptions: 5,
    recYds: 70,
    recTd: 0.4,
    targets: 8,
  };
}

function usage(over: Partial<UsagePerGame> = {}): UsagePerGame {
  return {
    snapShare: 0.8,
    targets: 8,
    carries: 0,
    airYards: 80,
    passAttempts: 0,
    ...over,
  };
}

describe("updateParts", () => {
  it("leaves the line alone where the season says what August did", () => {
    const moved = updateParts({
      anchor: anchor(),
      observed: usage(),
      fromSeason: 0.6,
      levelRatio: 1,
    });

    expect(moved.targets).toBeCloseTo(8, 5);
    expect(moved.recYds).toBeCloseTo(70, 5);
  });

  it("takes targets off a player whose role shrank", () => {
    const moved = updateParts({
      anchor: anchor(),
      observed: usage({ targets: 2, snapShare: 0.1 }),
      fromSeason: 0.5,
      levelRatio: 0.5,
    });

    expect(moved.targets).toBeCloseTo(5, 5);
    expect(moved.receptions).toBeLessThan(5);
    expect(moved.recYds).toBeLessThan(70);
  });

  it("scores what the level says once the parts have moved", () => {
    const moved = updateParts({
      anchor: anchor(),
      observed: usage({ targets: 3 }),
      fromSeason: 0.5,
      levelRatio: 0.4,
    });
    const was = anchor();
    const pointsOf = (p: StatParts) => p.receptions + p.recYds / 10 + p.recTd * 6;

    expect(pointsOf(moved) / pointsOf(was)).toBeCloseTo(0.4, 2);
  });

  it("holds a part off a chance he never gets", () => {
    const moved = updateParts({
      anchor: { ...anchor(), passAtt: 0.02, passYds: 0.2 },
      observed: usage({ passAttempts: 0.5 }),
      fromSeason: 0.6,
      levelRatio: 1,
    });

    expect(moved.passYds).toBeCloseTo(0.2, 5);
  });

  it("never gives him more catches than targets", () => {
    const moved = updateParts({
      anchor: anchor(),
      observed: usage({ targets: 1 }),
      fromSeason: 0.9,
      levelRatio: 1.5,
    });

    expect(moved.receptions).toBeLessThanOrEqual(moved.targets);
  });
});

describe("partsAtLevel", () => {
  it("scores the level it was asked for", () => {
    for (const ppg of [0.4, 4, 12.2, 30]) {
      expect(pointsOfLine(partsAtLevel(anchor(), ppg))).toBeCloseTo(ppg, 4);
    }
  });

  it("leaves the chances he gets where they are", () => {
    const moved = partsAtLevel(anchor(), 6);

    expect(moved.targets).toBeCloseTo(8, 5);
    expect(moved.receptions).toBeLessThan(5);
  });

  it("raises his targets to cover the catches the level buys", () => {
    const thin = { ...anchor(), targets: 5.2 };
    const moved = partsAtLevel(thin, 4 * pointsOfLine(thin));

    expect(moved.receptions).toBeGreaterThan(5.2);
    expect(moved.targets).toBeGreaterThanOrEqual(moved.receptions);
  });

  it("stops at the cap rather than scaling a line off nothing", () => {
    const moved = partsAtLevel(anchor(), 500);

    expect(pointsOfLine(moved)).toBeLessThan(500);
    expect(pointsOfLine(moved)).toBeCloseTo(5 * pointsOfLine(anchor()), 4);
  });

  it("leaves a line nothing pays for alone", () => {
    const empty = { ...blankParts(), targets: 3 };

    expect(partsAtLevel(empty, 9).targets).toBe(3);
  });
});

import { describe, expect, it } from "vitest";
import {
  leverageUsage, zeroCounted, type Counted, type LeverageRow,
} from "./leverageUsage.js";

/** one week of one player, with his side's totals beside it */
function row(
  week: number,
  player: string,
  his: Partial<Counted>,
  side: Partial<Counted>,
  weight = 1,
): LeverageRow {
  const counted = (over: Partial<Counted>, scale: number): Counted => {
    const out = zeroCounted();

    for (const [field, value] of Object.entries(over)) {
      out[field as keyof Counted] = value * scale;
    }

    return out;
  };

  return {
    season: 2025,
    week,
    team: "NE",
    player,
    raw: counted(his, 1),
    weighted: counted(his, weight),
    side: counted(side, 1),
    sideWeighted: counted(side, weight),
  };
}

const PLAY = { targets: 40, carries: 25 };

/** a side's week with two backs and nobody else on it */
function week(
  at: number, one: Partial<Counted>, other: Partial<Counted>,
  oneWeight = 1, otherWeight = 1,
): LeverageRow[] {
  return [
    row(at, "starter", one, PLAY, oneWeight),
    row(at, "backup", other, PLAY, otherWeight),
  ];
}

const positions = new Map([["starter", "RB"], ["backup", "RB"]]);
const at = (through: number) => ({ season: 2025, through, positions });

describe("leverageUsage", () => {
  it("divides a player by his side over the weeks asked for", () => {
    const rows = [
      ...week(1, { carries: 15 }, { carries: 5 }),
      ...week(2, { carries: 15 }, { carries: 5 }),
    ];
    const usage = leverageUsage(rows, at(2));

    expect(usage.get("starter")!.rawCarryShare).toBeCloseTo(30 / 50);
    expect(usage.get("backup")!.rawCarryShare).toBeCloseTo(10 / 50);
  });

  it("will not read a week later than the one asked about", () => {
    const rows = [
      ...week(1, { carries: 5 }, { carries: 15 }),
      ...week(2, { carries: 20 }, { carries: 0 }),
    ];

    expect(leverageUsage(rows, at(1)).get("starter")!.rawCarryShare)
      .toBeCloseTo(5 / 25);
  });

  it("separates two backs with the same raw share by when they played", () => {
    // Both take ten of their side's twenty five carries every week. The
    // starter's came while the game was live and the backup's came after
    // it was gone, which is the whole point of the weighting.
    const rows = [
      ...week(1, { carries: 10 }, { carries: 10 }, 0.9, 0.1),
      ...week(2, { carries: 10 }, { carries: 10 }, 0.9, 0.1),
    ];
    const usage = leverageUsage(rows, at(2));

    expect(usage.get("starter")!.rawCarryShare)
      .toBeCloseTo(usage.get("backup")!.rawCarryShare);
    expect(usage.get("starter")!.carryShare)
      .toBeGreaterThan(usage.get("backup")!.carryShare);
  });

  it("counts a missed week against him rather than passing over it", () => {
    const rows = [
      ...week(1, { carries: 10 }, { carries: 10 }),
      row(2, "backup", { carries: 10 }, PLAY),
    ];

    expect(leverageUsage(rows, at(2)).get("starter")!.rawCarryShare)
      .toBeCloseTo(10 / 50);
  });

  it("reports how many weeks of his own a count rests on", () => {
    const rows = [
      ...week(1, { carries: 10 }, { carries: 10 }),
      row(2, "backup", { carries: 10 }, PLAY),
    ];
    const usage = leverageUsage(rows, at(2));

    expect(usage.get("starter")!.weeks).toBe(1);
    expect(usage.get("backup")!.weeks).toBe(2);
  });

  it("puts targets and carries together for the one share a back gets", () => {
    const rows = week(1, { targets: 4, carries: 16 }, { targets: 2, carries: 4 });

    expect(leverageUsage(rows, at(1)).get("starter")!.rawWorkShare)
      .toBeCloseTo(20 / 65);
  });
});

describe("leverageUsage, the trend", () => {
  /** a back whose share climbs from a tenth to half over six weeks */
  const climbing = (weeks: number) => {
    const rows: LeverageRow[] = [];

    for (let at = 1; at <= weeks; at++) {
      const rising = at > weeks - 3 ? 12 : 3;
      rows.push(...week(at, { carries: rising }, { carries: 25 - rising }));
    }

    return rows;
  };

  it("has nothing to say in week three, with nothing before the window", () => {
    const usage = leverageUsage(climbing(3), at(3));

    expect(usage.get("starter")!.carryTrend).toBe(0);
    expect(usage.get("backup")!.carryTrend).toBe(0);
  });

  it("reads a back who was not playing and now is as a rise", () => {
    const rows = [
      row(1, "starter", { carries: 20 }, PLAY),
      row(2, "starter", { carries: 20 }, PLAY),
      row(3, "starter", { carries: 20 }, PLAY),
      ...week(4, { carries: 10 }, { carries: 10 }),
      ...week(5, { carries: 10 }, { carries: 10 }),
      ...week(6, { carries: 10 }, { carries: 10 }),
    ];

    expect(leverageUsage(rows, at(6)).get("backup")!.carryTrend)
      .toBeGreaterThan(0.1);
  });

  it("gives a rising back a trend above nothing", () => {
    expect(leverageUsage(climbing(6), at(6)).get("starter")!.carryTrend)
      .toBeGreaterThan(0.1);
  });

  it("keeps more of the trend for a back with six weeks than with four", () => {
    const six = leverageUsage(climbing(6), at(6)).get("starter")!.carryTrend;
    const four = leverageUsage(climbing(4), at(4)).get("starter")!.carryTrend;

    expect(six).toBeGreaterThan(four);
  });

  it("does not let two weeks outrank six on the same climb", () => {
    // Two weeks of the same rise gives one week either side of the
    // window edge, which is nowhere near enough to speak for itself.
    const twoWeeks = leverageUsage(climbing(2), at(2)).get("starter")!;
    const sixWeeks = leverageUsage(climbing(6), at(6)).get("starter")!;

    expect(sixWeeks.carryTrend).toBeGreaterThan(twoWeeks.carryTrend);
  });

  it("pulls a falling back up toward what his position did", () => {
    const falling: LeverageRow[] = [];

    for (let week = 1; week <= 6; week++) {
      const fading = week > 3 ? 3 : 12;
      falling.push(row(week, "starter", { carries: fading }, PLAY));
      falling.push(row(week, "backup", { carries: 25 - fading }, PLAY));
    }

    const usage = leverageUsage(falling, at(6));

    expect(usage.get("starter")!.carryTrend).toBeLessThan(0);
    // and the two sides of the same swap cancel, so the position's own
    // mean trend sits at nothing and neither is moved off his own number
    expect(usage.get("starter")!.carryTrend)
      .toBeCloseTo(-usage.get("backup")!.carryTrend, 2);
  });
});

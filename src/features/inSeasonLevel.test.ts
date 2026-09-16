import { describe, expect, it } from "vitest";
import {
  fitRoleLevel,
  fitUpdateShape,
  gamesSinceBreak,
  summarizeWindow,
  updateLevel,
  type InSeasonFit,
  type PlayedWeek,
  type RoleLevelRow,
  type UpdateCase,
  type UpdateShape,
} from "./inSeasonLevel.js";

const SHAPE: UpdateShape = {
  decay: 1,
  breakGap: Infinity,
  roleCap: 0.5,
  roleGames: 2,
  pointsCap: 0.3,
  pointsGames: 5,
};

function week(over: Partial<PlayedWeek> = {}): PlayedWeek {
  return {
    week: 1,
    points: 10,
    snapShare: 0.8,
    targets: 7,
    carries: 0,
    airYards: 70,
    passAttempts: 0,
    ...over,
  };
}

/** a straight line from targets to points, which the ridge should find */
function roleRows(): RoleLevelRow[] {
  const rows: RoleLevelRow[] = [];

  for (let i = 0; i < 400; i++) {
    const targets = (i % 12) + 1;
    rows.push({
      position: "WR",
      usage: {
        snapShare: targets / 12,
        targets,
        carries: 0,
        airYards: targets * 10,
        passAttempts: 0,
      },
      ppg: targets * 1.5,
    });
  }

  return rows;
}

function fitWith(shape: UpdateShape): InSeasonFit {
  return { role: fitRoleLevel(roleRows()), shape };
}

describe("summarizeWindow", () => {
  it("counts every game the same where nothing decays", () => {
    const summary = summarizeWindow(
      [week({ week: 1, points: 4 }), week({ week: 2, points: 16 })],
      SHAPE,
    );

    expect(summary.toDatePpg).toBeCloseTo(10);
    expect(summary.effectiveGames).toBeCloseTo(2);
  });

  it("leans on the latest game once the window decays", () => {
    const summary = summarizeWindow(
      [week({ week: 1, points: 4 }), week({ week: 2, points: 16 })],
      { ...SHAPE, decay: 0.5 },
    );

    expect(summary.toDatePpg).toBeGreaterThan(10);
    expect(summary.effectiveGames).toBeLessThan(2);
  });
});

describe("gamesSinceBreak", () => {
  const backup = [1, 2, 3].map((w) => week({ week: w, snapShare: 0.1 }));
  const starter = [4, 5, 6].map((w) => week({ week: w, snapShare: 0.9 }));

  it("drops the games before a role changed outright", () => {
    expect(gamesSinceBreak([...backup, ...starter], 0.2)).toHaveLength(3);
  });

  it("keeps every game where the role held", () => {
    const steady = [...backup, ...backup];

    expect(gamesSinceBreak(steady, 0.2)).toHaveLength(6);
  });

  it("keeps every game where no threshold was set", () => {
    const weeks = [...backup, ...starter];

    expect(gamesSinceBreak(weeks, Infinity)).toHaveLength(6);
  });
});

describe("updateLevel", () => {
  it("returns the anchor before a snap is played", () => {
    const said = updateLevel(fitWith(SHAPE), {
      anchor: 12,
      position: "WR",
      weeks: [],
    });

    expect(said.ppg).toBe(12);
  });

  it("reads points a game off the usage alone", () => {
    const said = updateLevel(fitWith(SHAPE), {
      anchor: 5,
      position: "WR",
      weeks: [week({ targets: 10, points: 0, snapShare: 10 / 12 })],
    });

    expect(said.roleLevel).toBeGreaterThan(10);
  });

  it("puts more on the season as the games pile up", () => {
    const fit = fitWith(SHAPE);
    const weeks = [1, 2, 3, 4, 5, 6, 7, 8].map((w) => week({ week: w }));
    const after = weeks.map((_, i) =>
      updateLevel(fit, {
        anchor: 20,
        position: "WR",
        weeks: weeks.slice(0, i + 1),
      }),
    );

    for (let i = 1; i < after.length; i++) {
      expect(after[i]!.weightOnRole).toBeGreaterThan(after[i - 1]!.weightOnRole);
      expect(after[i]!.ppg).toBeLessThan(after[i - 1]!.ppg);
    }
  });

  it("leaves the prior some of the number however long the season runs", () => {
    const weeks = Array.from({ length: 17 }, (_, i) => week({ week: i + 1 }));
    const said = updateLevel(fitWith(SHAPE), {
      anchor: 20,
      position: "WR",
      weeks,
    });

    expect(said.weightOnRole + said.weightOnPoints).toBeLessThan(1);
  });
});

describe("fitUpdateShape", () => {
  /**
   * Every player here goes on to average what his usage said, so the
   * fit should hand the role term as much as it is allowed and leave
   * the anchor, which is set wrong on purpose, almost nothing.
   */
  const cases: UpdateCase[] = Array.from({ length: 200 }, (_, i) => {
    const targets = (i % 12) + 1;
    const weeks = [1, 2, 3, 4].map((w) =>
      week({ week: w, targets, snapShare: targets / 12, airYards: targets * 10 }),
    );

    return { position: "WR", anchor: 3, weeks, restPpg: targets * 1.5 };
  });

  it("puts the weight where the evidence is", () => {
    const shape = fitUpdateShape(fitRoleLevel(roleRows()), cases);

    expect(shape.roleCap).toBeGreaterThanOrEqual(0.6);
    expect(shape.roleCap).toBeGreaterThan(shape.pointsCap);
  });

  it("holds anything the caller pins", () => {
    const shape = fitUpdateShape(fitRoleLevel(roleRows()), cases, {
      roleCap: 0,
    });

    expect(shape.roleCap).toBe(0);
  });
});

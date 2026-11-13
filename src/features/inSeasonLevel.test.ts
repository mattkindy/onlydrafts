import { describe, expect, it } from "vitest";
import {
  fitRoleLevel,
  fitUpdateShape,
  gamesRead,
  gamesSinceBreak,
  riseReadFor,
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

  /**
   * A starter who loses the job and a backup who gets it are read alike
   * by one gap. A drop can be given a gap of its own, which the in-season
   * eval marks against the one gap the build ships.
   */
  it("reads a drop apart from a rise where it is given its own gap", () => {
    const benched = [...starter, ...backup];

    expect(gamesSinceBreak(benched, Infinity, 0.15)).toHaveLength(3);
    expect(gamesSinceBreak([...backup, ...starter], Infinity, 0.15)).toHaveLength(6);
  });

  it("breaks a drop at the rise's gap when given none of its own", () => {
    expect(gamesSinceBreak([...starter, ...backup], 0.2)).toHaveLength(3);
  });

  it("holds a drop to two games down when asked, so one hurt game is not a demotion", () => {
    const leftHurt = [...starter, week({ week: 7, snapShare: 0.05 }),
      week({ week: 8, snapShare: 0.9 }), week({ week: 9, snapShare: 0.9 })];

    expect(gamesSinceBreak(leftHurt, Infinity, 0.15, true)).toHaveLength(6);
    expect(gamesSinceBreak(leftHurt, Infinity, 0.15)).toHaveLength(3);
    expect(gamesSinceBreak([...starter, ...backup], Infinity, 0.15, true))
      .toHaveLength(3);
  });

  it("holds a rise to two games up when asked, so one fill-in game is not a promotion", () => {
    const filledIn = [...backup, week({ week: 4, snapShare: 0.95 }),
      week({ week: 5, snapShare: 0.1 }), week({ week: 6, snapShare: 0.1 })];
    const tookOver = [...backup, week({ week: 4, snapShare: 0.1 }),
      week({ week: 5, snapShare: 0.6 }), week({ week: 6, snapShare: 0.7 })];

    expect(gamesSinceBreak(filledIn, 0.2, 0.2, false, true)).toHaveLength(6);
    expect(gamesSinceBreak([...backup, ...starter], 0.3, 0.2, false, true)).toHaveLength(3);
    expect(gamesSinceBreak(tookOver, 0.3, 0.2, false, true)).toHaveLength(3);
  });
});

describe("gamesRead", () => {
  const backup = [1, 2, 3].map((w) => week({ week: w, snapShare: 0.1 }));
  /** one big game in the last three, which the wary rise does not break */
  const oneGame = [...backup, week({ week: 4, snapShare: 0.1 }),
    week({ week: 5, snapShare: 0.1 }), week({ week: 6, snapShare: 0.9 })];
  const wary: UpdateShape = {
    ...SHAPE, breakGap: 0.3, dropGap: 0.2, riseHeld: true,
  };
  const promoted = { reason: "promotion", fromWeek: 6 } as const;

  it("reads a rise as the break does where it has no reason", () => {
    expect(gamesRead(oneGame, wary)).toHaveLength(6);
    expect(gamesRead(oneGame, { ...wary, riseBy: { promotion: { games: "since" } } }))
      .toHaveLength(6);
  });

  it("reads a rise as the break does where its reason has no read", () => {
    expect(gamesRead(oneGame, { ...wary, riseBy: { "fill-in": { games: "whole" } } },
      promoted)).toHaveLength(6);
  });

  it("keeps only the games since he rose for a reason read at once", () => {
    const shape = { ...wary, riseBy: { promotion: { games: "since" as const } } };

    expect(gamesRead(oneGame, shape, promoted).map((w) => w.week)).toEqual([6]);
  });

  it("keeps every game, or the games before he rose, where the read says to", () => {
    const tookOver = [...backup, ...[4, 5, 6].map((w) => week({ week: w, snapShare: 0.9 }))];
    const filling = { reason: "fill-in", fromWeek: 4 } as const;

    expect(gamesSinceBreak(tookOver, 0.3, 0.2, false, true)).toHaveLength(3);
    expect(gamesRead(tookOver, { ...wary, riseBy: { "fill-in": { games: "whole" } } },
      filling)).toHaveLength(6);
    expect(gamesRead(tookOver, { ...wary, riseBy: { "fill-in": { games: "before" } } },
      filling).map((w) => w.week)).toEqual([1, 2, 3]);
  });

  it("breaks at the read's own gap and hold", () => {
    const shape = {
      ...wary, riseBy: { depth: { games: "break" as const, gap: 0.2, held: false } },
    };
    const moved = { reason: "depth", fromWeek: 6 } as const;
    const twoGames = [...backup, week({ week: 4, snapShare: 0.1 }),
      week({ week: 5, snapShare: 0.45 }), week({ week: 6, snapShare: 0.45 })];

    expect(gamesRead(twoGames, wary)).toHaveLength(6);
    expect(gamesRead(twoGames, shape, moved)).toHaveLength(3);
  });

  it("reads a man whose snaps fell on the whole as a drop, whatever his reason", () => {
    const starter = [1, 2, 3].map((w) => week({ week: w, snapShare: 0.6 }));
    const fell = [...starter, week({ week: 4, snapShare: 0.85 }),
      week({ week: 5, snapShare: 0.1 }), week({ week: 6, snapShare: 0.1 })];
    const shape = { ...wary, riseBy: { promotion: { games: "since" as const } } };

    expect(riseReadFor(fell, shape, { reason: "promotion", fromWeek: 4 }))
      .toBeUndefined();
    expect(gamesRead(fell, shape, { reason: "promotion", fromWeek: 4 }))
      .toHaveLength(3);
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

  it("hands a share of the season's weight back to the anchor where a read says to", () => {
    const backup = [1, 2, 3].map((w) => week({ week: w, snapShare: 0.1 }));
    const weeks = [...backup, ...[4, 5, 6].map((w) => week({ week: w, snapShare: 0.9 }))];
    const rise = { reason: "fill-in", fromWeek: 4 } as const;
    const whole = updateLevel(fitWith({
      ...SHAPE, riseBy: { "fill-in": { games: "whole" } },
    }), { anchor: 4, position: "WR", weeks, rise });
    const half = updateLevel(fitWith({
      ...SHAPE, riseBy: { "fill-in": { games: "whole", toward: 0.5 } },
    }), { anchor: 4, position: "WR", weeks, rise });

    expect(half.weightOnRole).toBeCloseTo(whole.weightOnRole / 2);
    expect(half.weightOnPoints).toBeCloseTo(whole.weightOnPoints / 2);
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

  /**
   * Starters benched after three games, who go on to score what the
   * smaller role pays. Only a break on the drop forgets the games before.
   */
  const benched: UpdateCase[] = Array.from({ length: 200 }, (_, i) => {
    const was = (i % 4) + 9;
    const now = (i % 3) + 1;
    const weeks = [1, 2, 3, 4, 5, 6].map((w) => {
      const targets = w <= 3 ? was : now;

      return week({ week: w, targets, snapShare: targets / 12, airYards: targets * 10 });
    });

    return { position: "WR", anchor: was * 1.5, weeks, restPpg: now * 1.5 };
  });

  it("gives a drop a gap of its own only when asked", () => {
    const role = fitRoleLevel(roleRows());

    expect(fitUpdateShape(role, benched).dropGap).toBeUndefined();
    expect(fitUpdateShape(role, benched, {}, { apart: true }).dropGap)
      .toBeLessThan(Infinity);
  });
});

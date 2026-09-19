import { describe, expect, it } from "vitest";
import {
  benchExamples, benchFits, benchingBy, benchingIn, benchingKey,
  fillBenchingTerms, type BenchingSeason,
} from "./expectedBench.js";
import type { OpportunitySeason } from "./contingentBench.js";
import type { BenchExample } from "../model/expectedSleepers.js";
import type { Row } from "./sleeperBench.js";

const CLUB = "NE";
const WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);

/** one player's week by week work, as a stat file would have left it */
const did = (
  weeks: number[], opportunities: number, points: number,
): Map<number, { opportunities: number; points: number }> =>
  new Map(weeks.map((week) => [week, { opportunities, points }]));

interface Man {
  id: string;
  before: { weeks: number[]; opportunities: number; points: number };
  after: { weeks: number[]; opportunities: number; points: number };
}

function aSeason(men: Man[], over: Partial<BenchingSeason> = {}): BenchingSeason {
  const read: OpportunitySeason = {
    season: 2022,
    weeks: new Map(men.map((man) => [man.id, new Map([
      ...did(man.before.weeks, man.before.opportunities, man.before.points),
      ...did(man.after.weeks, man.after.opportunities, man.after.points),
    ])])),
    positions: new Map(men.map((man) => [man.id, "RB"])),
    names: new Map(men.map((man) => [man.id, man.id])),
    clubBy: new Map(men.map((man) => [
      man.id, new Map(WEEKS.map((week) => [week, CLUB])),
    ])),
    clubWeeks: new Map([[CLUB, new Set(WEEKS)]]),
  };

  return {
    read,
    snaps: new Map(),
    roster: {
      age: new Map(),
      draftOverall: new Map(),
      experience: new Map(),
      activeWeeks: new Map(men.map((man) => [man.id, new Set(WEEKS)])),
    },
    listed: new Map(),
    ...over,
  };
}

const THE_JOB: Man = {
  id: "starter",
  before: { weeks: [1, 2, 3, 4], opportunities: 12, points: 12 },
  after: { weeks: [5, 6, 7, 8, 9, 10, 11, 12], opportunities: 4, points: 4 },
};

const THE_BACKUP: Man = {
  id: "backup",
  before: { weeks: [1, 2, 3, 4], opportunities: 2, points: 2 },
  after: { weeks: [5, 6, 7, 8, 9, 10, 11, 12], opportunities: 15, points: 15 },
};

const THE_THIRD: Man = {
  id: "third",
  before: { weeks: [1, 2, 3, 4], opportunities: 1, points: 1 },
  after: { weeks: [5, 6, 7, 8], opportunities: 1, points: 1 },
};

describe("reading a benching off the work", () => {
  it("calls it a benching when the backup takes the work off a fit man", () => {
    const cases = benchingIn(aSeason([THE_JOB, THE_BACKUP, THE_THIRD]), [4]);
    const mine = cases.find((one) => one.playerId === "backup")!;

    expect(mine.starterId).toBe("starter");
    expect(mine.benched).toBe(true);
    expect(cases.find((one) => one.playerId === "third")!.benched).toBe(false);
  });

  it("says nothing when the man in front is on the injury report", () => {
    const cases = benchingIn(
      aSeason([THE_JOB, THE_BACKUP], {
        listed: new Map([["starter", new Set([5, 6, 7, 8])]]),
      }),
      [4],
    );

    expect(cases.find((one) => one.playerId === "backup")!.benched)
      .toBeUndefined();
  });

  it("says nothing when the club has fewer than four games left", () => {
    const cases = benchingIn(aSeason([THE_JOB, THE_BACKUP]), [10]);

    expect(cases).not.toHaveLength(0);
    expect(cases.every((one) => one.benched === undefined)).toBe(true);
  });

  it("counts the weeks the man in front missed after the cut", () => {
    const quiet: Man = {
      ...THE_JOB,
      after: { weeks: [5, 6], opportunities: 4, points: 4 },
    };
    const cases = benchingIn(aSeason([quiet, THE_BACKUP]), [4]);

    expect(cases.find((one) => one.playerId === "backup")!.starterMissedAfter)
      .toBe(6);
  });

  it("reads the starter against what his price pays", () => {
    const cases = benchingIn(
      aSeason([THE_JOB, THE_BACKUP]), [4], () => 9,
    );
    const mine = cases.find((one) => one.playerId === "backup")!;

    expect(mine.priced).toBe(true);
    expect(mine.cut.starterGap).toBeCloseTo(3, 10);
  });

  it("leaves the gap out when the season has no price curve", () => {
    const cases = benchingIn(aSeason([THE_JOB, THE_BACKUP]), [4]);

    expect(cases.every((one) => one.priced)).toBe(false);
    expect(benchExamples(cases)).toEqual([]);
  });

  it("counts the weeks the job was open and what he scored in them", () => {
    const quiet: Man = {
      ...THE_JOB,
      after: { weeks: [9, 10, 11, 12], opportunities: 4, points: 4 },
    };
    const cases = benchingIn(aSeason([quiet, THE_BACKUP]), [4]);
    const mine = cases.find((one) => one.playerId === "backup")!;

    expect(mine.openWeeks).toBe(4);
    expect(mine.pointsWhenOpen).toBe(60);
  });

  it("marks a backup taking a starter's share of the snaps", () => {
    const withSnaps = aSeason([THE_JOB, THE_BACKUP], {
      snaps: new Map([
        ["backup", new Map(WEEKS.map((week) => [week, week > 4 ? 0.7 : 0.1]))],
      ]),
    });
    const mine = benchingIn(withSnaps, [4])
      .find((one) => one.playerId === "backup")!;

    expect(mine.tookStartersShare).toBe(true);
    expect(mine.openWeeks).toBe(8);
  });

  it("files a pair under its season, week and backup", () => {
    expect(benchingKey(2022, 4, "backup")).toBe("2022|4|backup");
  });
});

/** a bench row with only the fields the benching terms are written onto */
const aRow = (playerId: string, season = 2022, week = 4): Row => ({
  cut: {
    season, week, playerId, playerName: playerId, position: "RB",
    price: 120, drafted: true,
    priceMedian: 8, priceP10: 4, priceP90: 14, priceHitRate: 0.2,
    rawWorkShare: 0.2, leverageWorkShare: 0.2, trend: 0,
    ppgSoFar: 9, gamesPlayed: 4, pickSpread: 0.2, hasPickSpread: true,
    inSeasonPpg: 9, roleLevelPpg: 9,
  },
  club: CLUB,
  weeksLeft: 8,
  gamesAfter: 8,
  restOfSeasonPpg: 9,
  restOfSeasonTotal: 72,
  restOfSeasonPerGame: 9,
  hit: false,
  hitPerGame: false,
  tierMargin: 0,
});

describe("putting the benching terms on a bench row", () => {
  const cases = benchingBy(benchingIn(aSeason([THE_JOB, THE_BACKUP]), [4]));

  it("writes the pair's features and the fit's chance onto the backup", () => {
    const rows = [aRow("backup")];
    fillBenchingTerms(rows, cases, () => 0.31);

    expect(rows[0]!.cut.snapTrend).toBe(0);
    expect(rows[0]!.cut.backupCapital).toBe(false);
    expect(rows[0]!.cut.benchedChance).toBe(0.31);
  });

  it("leaves a player with nobody in front of him alone", () => {
    const rows = [aRow("nobody")];
    fillBenchingTerms(rows, cases, () => 0.31);

    expect(rows[0]!.cut.benchedChance).toBeUndefined();
    expect(rows[0]!.cut.starterGap).toBeUndefined();
  });

  it("reads the pair by season and week, not by player alone", () => {
    const rows = [aRow("backup", 2023, 4), aRow("backup", 2022, 6)];
    fillBenchingTerms(rows, cases, () => 0.31);

    expect(rows.every((row) => row.cut.benchedChance === undefined)).toBe(true);
  });
});

describe("the benching fit for each season", () => {
  const teaching: BenchExample[] = Array.from({ length: 40 }, (_, i) => ({
    season: 2018 + (i % 3),
    cut: {
      position: "RB",
      starterGap: i % 5,
      backupCapital: i % 2 === 0,
      snapTrend: (i % 7) / 100,
    },
    benched: i % 4 === 0,
  }));

  it("reads only the seasons before the one it is asked about", () => {
    expect(benchFits([2018, 2019, 2020], teaching)(2020)!.trainedOn)
      .toEqual([2018, 2019]);
  });

  it("gives the earliest season the fit from the one after it", () => {
    const fits = benchFits([2018, 2019, 2020], teaching);

    expect(fits(2018)!.trainedOn).toEqual(fits(2019)!.trainedOn);
  });

  it("has no fit to give when only one season is priced", () => {
    expect(benchFits([2018], teaching)(2018)).toBeUndefined();
  });
});

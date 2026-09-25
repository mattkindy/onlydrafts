import { describe, expect, it } from "vitest";

import { buildResidualModel } from "../src/backtest/intervals.js";
import { projectionKey } from "../src/data/sleeperProjections.js";
import type { WeekStatus } from "../src/data/weeklyStatus.js";
import {
  boardSlateRows, fixturesIn, type BoardPlayer, type BoardWeek,
} from "./slateRows.js";

const residuals = buildResidualModel(
  Array.from({ length: 40 }, (_, i) => ({
    position: "TE", predicted: 4 + i / 2, actual: 4 + i / 2 + ((i % 9) - 4),
  })),
  4,
);

const games = [
  { season: 2026, week: 3, homeTeamId: "NO", awayTeamId: "LV" },
  { season: 2026, week: 3, homeTeamId: "GB", awayTeamId: "ATL" },
  { season: 2026, week: 4, homeTeamId: "LV", awayTeamId: "KC" },
];

const bowers: BoardPlayer = {
  playerId: "00-0039338",
  name: "Brock Bowers",
  position: "TE",
  teamId: "LV",
  line: 14.3,
  catches: 5.7,
  catchShare: 0.98,
};

const statusOf = (said: Record<string, WeekStatus>) =>
  (playerId: string) => said[playerId];

function weekOf(over: Partial<BoardWeek> = {}): BoardWeek {
  return {
    season: 2026,
    week: 3,
    residuals,
    fixtures: fixturesIn(games, 2026, 3),
    written: [],
    modelled: new Set(),
    statusOf: statusOf({}),
    projections: new Map([[projectionKey(2026, 3, bowers.playerId), {
      season: 2026, week: 3, gsisId: bowers.playerId, position: "TE",
      points: 13.41, targets: 6.96, carries: 0.23, catches: 5.57,
    }]]),
    quiet: new Set(),
    missedOf: () => 2,
    skyOf: () => ({ note: undefined, lift: 1 }),
    ...over,
  };
}

describe("a board player the weekly model has no row for", () => {
  it("gets a row with his opponent and Sleeper's number", () => {
    const [row] = boardSlateRows([bowers], weekOf());

    expect(row).toBeDefined();
    expect(row!.opponent).toBe("@ NO");
    expect(row!.team).toBe("LV");
    expect(row!.ours).toBe(14.3);
    expect(row!.sleeper).toBe(13.4);
    expect(row!.average).toBe(13.9);
    expect(row!.catches).toBe(5.57);
    expect(row!.gamesMissed).toBe(2);
    expect(row!.lineFrom).toBe("board");
    expect(row!.floor).toBeLessThan(row!.average);
    expect(row!.ceiling).toBeGreaterThan(row!.average);
  });

  it("carries the word the injury report used for him", () => {
    const [row] = boardSlateRows([bowers], weekOf({
      statusOf: statusOf({
        [bowers.playerId]: {
          out: false, report: "Questionable", questionable: true,
          limitedPractice: true, team: "LV", position: "TE",
        },
      }),
    }));

    expect(row!.questionable).toBe(true);
    expect(row!.status).toBe("Questionable");
    expect(row!.average).toBe(13.9);
  });

  it("reads zero when his club has ruled him out", () => {
    const [row] = boardSlateRows([bowers], weekOf({
      statusOf: statusOf({
        [bowers.playerId]: {
          out: true, report: "Out", questionable: false,
          limitedPractice: false, team: "LV", position: "TE",
        },
      }),
    }));

    expect(row!.ruledOut).toBe(true);
    expect(row!.average).toBe(0);
    expect(row!.ceiling).toBe(0);
  });

  it("reads zero where Sleeper listed him without a number", () => {
    const [row] = boardSlateRows([bowers], weekOf({
      projections: new Map(),
      quiet: new Set([projectionKey(2026, 3, bowers.playerId)]),
    }));

    expect(row!.sleeper).toBe(0);
    expect(row!.average).toBe(0);
    expect(row!.ours).toBe(14.3);
  });

  it("keeps the board's line alone where Sleeper never listed him", () => {
    const [row] = boardSlateRows([bowers], weekOf({ projections: new Map() }));

    expect(row!.sleeper).toBeNull();
    expect(row!.average).toBe(14.3);
  });

  it("applies the forecast the way the model's rows do", () => {
    const [row] = boardSlateRows([bowers], weekOf({
      skyOf: () => ({
        note: { wind: 22, temp: 50, wet: false, snow: false }, lift: 0.9,
      }),
      projections: new Map(),
    }));

    expect(row!.ours).toBe(12.9);
    expect(row!.weatherLift).toBe(0.9);
    expect(row!.weather?.wind).toBe(22);
  });

  it("is left to the app when his side is on its bye", () => {
    expect(boardSlateRows([{ ...bowers, teamId: "KC" }], weekOf())).toEqual([]);
  });

  it("is not written twice when the model already has him", () => {
    expect(boardSlateRows([bowers], weekOf({
      modelled: new Set([bowers.playerId]),
    }))).toEqual([]);
    expect(boardSlateRows([bowers], weekOf({
      written: [{ key: "brockbowers" }],
    }))).toEqual([]);
  });
});

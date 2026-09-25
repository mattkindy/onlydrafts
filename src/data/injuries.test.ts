import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";
import {
  countQuestionable, finalReportFor, mergeWeekStatus, parseSleeperStatus,
  readReportStatus, sameSleeperStatus, sleeperStatusToCsv, teamsAlreadyPlayed,
  type SleeperStatus,
} from "./injuries.js";
import type { GameRow } from "./nflverse.js";

const report = parseCsv(
  "season,week,gsis_id,position,report_primary_injury,report_status\n" +
  '2026,3,00-1,WR,"Ankle, knee",Questionable\n' +
  "2026,3,00-2,RB,Hamstring,Questionable\n" +
  "2026,3,00-3,S,Knee,Questionable\n" +
  "2026,3,00-4,TE,Back,\n" +
  "2026,4,00-5,QB,Hand,Questionable\n",
);

describe("countQuestionable", () => {
  it("counts a row whose injury has a comma in it", () => {
    expect(countQuestionable(report, 3, ["WR", "RB", "TE"])).toBe(2);
  });

  it("leaves out other positions, other weeks and a blank status", () => {
    expect(countQuestionable(report, 3, ["TE"])).toBe(0);
    expect(countQuestionable(report, 4, ["QB"])).toBe(1);
  });
});

const sleeper = (
  gsisId: string, status: string, week = 3, season = 2026,
): SleeperStatus => ({
  season, week, gsisId, team: "CHI", status, fetchedAt: "2026-09-23T11:20:00Z",
});

describe("readReportStatus", () => {
  it("counts Doubtful as out along with Out", () => {
    expect(readReportStatus("Out").out).toBe(true);
    expect(readReportStatus("Doubtful").out).toBe(true);
    expect(readReportStatus("Questionable"))
      .toEqual({ out: false, questionable: true });
  });

  it("reads a blank or unknown word as nothing wrong", () => {
    expect(readReportStatus("")).toEqual({ out: false, questionable: false });
    expect(readReportStatus("Note")).toEqual({ out: false, questionable: false });
  });
});

describe("finalReportFor", () => {
  it("keeps the week's filed statuses and drops the practice only rows", () => {
    const filed = finalReportFor(report, 3);

    expect([...filed.keys()].sort()).toEqual(["00-1", "00-2", "00-3"]);
    expect(filed.get("00-1")).toBe("Questionable");
  });
});

describe("mergeWeekStatus", () => {
  it("rules out a player Sleeper has as Doubtful when nflverse has no row", () => {
    const calls = mergeWeekStatus(
      2026, 3, new Map(), [sleeper("00-0039918", "Doubtful")],
    );

    expect(calls.get("00-0039918")).toEqual({
      out: true, questionable: false, report: "Doubtful", source: "sleeper",
    });
  });

  it("rules out the reserve lists and a suspension", () => {
    const calls = mergeWeekStatus(2026, 3, new Map(), [
      sleeper("ir", "IR"), sleeper("pup", "PUP"), sleeper("sus", "Sus"),
    ]);

    expect([...calls.values()].every((c) => c.out)).toBe(true);
  });

  it("keeps a Sleeper Questionable as questionable, not out", () => {
    const calls = mergeWeekStatus(
      2026, 3, new Map(), [sleeper("00-0038416", "Questionable")],
    );

    expect(calls.get("00-0038416")).toMatchObject({
      out: false, questionable: true,
    });
  });

  it("takes the club's final report over Sleeper once it lists him", () => {
    const calls = mergeWeekStatus(
      2026, 3,
      new Map([["00-1", "Questionable"]]),
      [sleeper("00-1", "Out")],
    );

    expect(calls.get("00-1")).toEqual({
      out: false, questionable: true, report: "Questionable", source: "report",
    });
  });

  it("ignores a snapshot taken for another week or season", () => {
    const calls = mergeWeekStatus(2026, 3, new Map(), [
      sleeper("00-1", "Out", 4),
      sleeper("00-2", "Out", 3, 2025),
    ]);

    expect(calls.size).toBe(0);
  });

  it("ignores a Sleeper word that says nothing about playing", () => {
    const calls = mergeWeekStatus(2026, 3, new Map(), [
      sleeper("00-1", "NA"), sleeper("00-2", "DNR"),
    ]);

    expect(calls.size).toBe(0);
  });

  it("reads the nflverse rows into the merge", () => {
    const calls = mergeWeekStatus(2026, 3, finalReportFor(report, 3), [
      sleeper("00-4", "Out"),
    ]);

    // 00-4 has only a practice row, so Sleeper decides for him
    expect(calls.get("00-4")?.source).toBe("sleeper");
    expect(calls.get("00-1")?.source).toBe("report");
  });
});

describe("the Sleeper status file", () => {
  it("comes back from its CSV as it went in", () => {
    const rows = [sleeper("00-2", "IR"), sleeper("00-1", "Questionable")];

    expect(parseSleeperStatus(sleeperStatusToCsv(rows)))
      .toEqual([rows[1], rows[0]]);
  });

  it("is the same snapshot when only the time it was taken differs", () => {
    const before = [sleeper("00-1", "Out"), sleeper("00-2", "IR")];
    const after = before.map((r) => ({ ...r, fetchedAt: "2026-09-24T11:20:00Z" }));

    expect(sameSleeperStatus(before, after)).toBe(true);
    expect(sameSleeperStatus(before, [sleeper("00-1", "Doubtful"), before[1]!]))
      .toBe(false);
    expect(sameSleeperStatus(before, before.map((r) => ({ ...r, week: 4 }))))
      .toBe(false);
    expect(sameSleeperStatus([], before)).toBe(false);
  });
});

describe("teamsAlreadyPlayed", () => {
  const game = (home: string, away: string, gameday: string): GameRow => ({
    id: `2026_03_${away}_${home}`, season: 2026, week: 3,
    homeTeamId: home, awayTeamId: away, gameday,
    indoors: false, divisional: false,
  });
  const games = [
    game("GB", "ATL", "2026-09-24"),
    game("BUF", "LAC", "2026-09-27"),
  ];

  it("names both clubs from a game played on an earlier day", () => {
    expect(teamsAlreadyPlayed(games, 2026, 3, "2026-09-25"))
      .toEqual(new Set(["GB", "ATL"]));
  });

  it("names nobody on the morning of the game", () => {
    expect(teamsAlreadyPlayed(games, 2026, 3, "2026-09-24").size).toBe(0);
  });
});

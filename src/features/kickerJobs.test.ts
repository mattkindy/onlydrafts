import { describe, expect, it } from "vitest";
import { accuracyOf, historyOf, kickerJobs, recordsFrom } from "./kickerJobs.js";
import type { KickerWeek } from "../data/nflverse.js";

const week = (
  playerId: string, teamId: string, week: number,
  parts: Record<string, number> = {},
): KickerWeek => ({
  playerId,
  name: playerId,
  season: 2025,
  week,
  teamId,
  opponentId: "OPP",
  parts: { fgm: 0, fgmiss: 0, xpm: 0, xpmiss: 0, ...parts },
});

const season = (
  playerId: string, teamId: string, weeks: number,
  parts: Record<string, number> = {},
) => Array.from({ length: weeks }, (_, i) =>
  week(playerId, teamId, i + 1, parts));

describe("kickerJobs", () => {
  it("leaves out a kicker nobody has signed", () => {
    const jobs = kickerJobs({
      lastSeason: season("retired", "BUF", 15, { fgm: 2, xpm: 2 }),
      soFar: [],
      onRoster: new Map([["signed", "BUF"]]),
    });

    expect(jobs.has("BUF")).toBe(false);
  });

  it("gives the job to whoever the roster says, not last season's club", () => {
    const jobs = kickerJobs({
      lastSeason: season("him", "NYJ", 16, { fgm: 2, xpm: 1 }),
      soFar: [],
      onRoster: new Map([["him", "ATL"]]),
    });

    expect(jobs.get("ATL")?.record.playerId).toBe("him");
    expect(jobs.has("NYJ")).toBe(false);
  });

  it("splits a club between two by who took more of them", () => {
    const jobs = kickerJobs({
      lastSeason: [
        ...season("busy", "KC", 12, { fgm: 2, xpm: 3 }),
        ...season("spare", "KC", 5, { fgm: 1, xpm: 1 }),
      ],
      soFar: [],
      onRoster: new Map([["busy", "KC"], ["spare", "KC"]]),
    });

    expect(jobs.get("KC")?.record.playerId).toBe("busy");
  });

  it("hands the job to whoever has kicked this season instead", () => {
    const jobs = kickerJobs({
      lastSeason: season("incumbent", "KC", 17, { fgm: 2, xpm: 3 }),
      soFar: [week("newcomer", "KC", 1, { fgm: 1 })],
      onRoster: new Map([["incumbent", "KC"], ["newcomer", "KC"]]),
    });

    expect(jobs.get("KC")?.record.playerId).toBe("newcomer");
    expect(jobs.get("KC")?.confirmed).toBe(true);
  });

  it("keeps a kicker with nothing behind him once he has kicked", () => {
    const jobs = kickerJobs({
      lastSeason: [],
      soFar: [week("rookie", "GB", 1, { fgm: 1 })],
      onRoster: new Map(),
    });

    expect(jobs.get("GB")?.record.games).toBe(0);
  });

  it("takes the job off a kicker Sleeper says the club released", () => {
    const jobs = kickerJobs({
      lastSeason: [
        ...season("cut", "ATL", 16, { fgm: 2, xpm: 2 }),
        ...season("signed", "BAL", 16, { fgm: 2, xpm: 2 }),
      ],
      soFar: [
        week("cut", "ATL", 9, { fgm: 1 }),
        week("signed", "BAL", 9, { fgm: 2 }),
      ],
      onRoster: new Map([["cut", "ATL"], ["signed", "BAL"]]),
      clubNow: new Map([
        ["cut", { team: null, name: "cut" }],
        ["signed", { team: "ATL", name: "signed" }],
      ]),
    });

    expect(jobs.get("ATL")?.record.playerId).toBe("signed");
    expect(jobs.get("ATL")?.thisSeason?.games).toBe(1);
    expect(jobs.has("BAL")).toBe(false);
  });

  it("leaves a kicker Sleeper does not know where he kicked", () => {
    const jobs = kickerJobs({
      lastSeason: season("him", "KC", 16, { fgm: 2 }),
      soFar: [week("him", "KC", 9, { fgm: 1 })],
      onRoster: new Map([["him", "KC"]]),
      clubNow: new Map([["someone", { team: "BUF", name: "someone" }]]),
    });

    expect(jobs.get("KC")?.record.playerId).toBe("him");
  });

  it("reads a whole season with nothing on disk as nobody having a job", () => {
    expect(kickerJobs({
      lastSeason: [],
      soFar: [],
      onRoster: new Map([["him", "BUF"]]),
    }).size).toBe(0);
  });
});

describe("accuracyOf", () => {
  it("counts the kicks he has missed this season beside last season's", () => {
    const jobs = kickerJobs({
      lastSeason: season("him", "ATL", 10, { fgm_50_59: 1 }),
      soFar: season("him", "ATL", 5, { fgmiss_50_59: 1 }),
      onRoster: new Map([["him", "ATL"]]),
    });
    const job = jobs.get("ATL")!;

    expect(historyOf(job.record).byBand[4]).toEqual({ attempts: 10, made: 10 });
    expect(accuracyOf(job).byBand[4]).toEqual({ attempts: 15, made: 10 });
  });
});

describe("historyOf", () => {
  it("leans an extra point rate toward the league until he has taken some", () => {
    const thin = recordsFrom(
      [week("thin", "KC", 1, { xpm: 1, xpmiss: 1 })]).get("thin")!;
    const settled = recordsFrom(
      season("settled", "KC", 17, { xpm: 3, xpmiss: 3 })).get("settled")!;

    expect(historyOf(thin).extraPointRate).toBeGreaterThan(0.85);
    expect(historyOf(settled).extraPointRate).toBeLessThan(0.7);
  });

  it("reads his attempts band by band", () => {
    const his = recordsFrom(
      season("him", "KC", 10, { fgm_40_49: 1, fgmiss_40_49: 1 })).get("him")!;
    const band = historyOf(his).byBand[3]!;

    expect(band).toEqual({ attempts: 20, made: 10 });
  });
});

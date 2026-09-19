import { describe, expect, it } from "vitest";

import type { Listed } from "./availability.ts";
import { lineOf, liveDraws, spreadOf } from "./matchups.ts";
import { isSplit, readSlate, slateUnder, withOutPlayersZeroed } from "./slate.ts";
import { normalizeName } from "./store.ts";

const built = readSlate({
  season: 2026,
  week: 1,
  perCatch: 0.5,
  players: [{
    name: "Ja'Marr Chase", position: "WR", team: "CIN", opponent: "v TB",
    ours: 17, sleeper: 17, average: 17, floor: 9, ceiling: 28, q1: 12, q3: 22,
    catches: 6,
  }, {
    name: "Joe Burrow", position: "QB", team: "CIN", opponent: "v TB",
    ours: 18, sleeper: null, average: 18, floor: 10, ceiling: 27,
    catches: 0,
  }],
});

describe("isSplit", () => {
  const backup = readSlate({
    season: 2026,
    week: 1,
    perCatch: 0.5,
    players: [{
      name: "Trey Lance", position: "QB", team: "LAC", opponent: "v KC",
      ours: 6.4, sleeper: 0, average: 3.2, floor: 0, ceiling: 9, catches: 0,
    }],
  }).rows[0]!;

  it("flags two numbers three or more points apart", () => {
    expect(isSplit({ ...backup, sleeper: 12 })).toBe(true);
    expect(isSplit({ ...backup, ours: 12, sleeper: 11 })).toBe(false);
  });

  it("leaves a player Sleeper projects nothing for unflagged", () => {
    expect(isSplit(backup)).toBe(false);
  });

  it("leaves a player Sleeper has no row for unflagged", () => {
    expect(isSplit({ ...backup, sleeper: null })).toBe(false);
  });
});

describe("slateUnder", () => {
  it("moves every point figure by the catch difference times his catches", () => {
    const ppr = slateUnder(built, 1);
    const chase = ppr.rows[0]!;

    expect(chase.ours).toBe(20);
    expect(chase.sleeper).toBe(20);
    expect(chase.blend).toBe(20);
    expect(chase.floor).toBe(12);
    expect(chase.q1).toBe(15);
    expect(chase.q3).toBe(25);
    expect(chase.ceiling).toBe(31);
    expect(ppr.perCatch).toBe(1);
  });

  it("takes points off for a league paying less than the build did", () => {
    const standard = slateUnder(built, 0);

    expect(standard.rows[0]!.blend).toBe(14);
  });

  it("leaves a player with no catches, and a missing figure, alone", () => {
    const burrow = slateUnder(built, 1).rows[1]!;

    expect(burrow.ours).toBe(18);
    expect(burrow.sleeper).toBeNull();
    expect(burrow.q1).toBeUndefined();
  });

  it("returns the same slate when the league pays what the build paid", () => {
    expect(slateUnder(built, 0.5)).toBe(built);
  });

  it("reads a slate written before the build said what a catch paid as half", () => {
    const older = readSlate({ season: 2025, week: 10, players: [] });

    expect(older.perCatch).toBe(0.5);
  });
});

const rowsOf = (slate: ReturnType<typeof readSlate>) =>
  new Map(slate.rows.map((r) => [normalizeName(r.name), r]));

const listedBy = (players: Record<string, Listed>) =>
  new Map(Object.entries(players).map(([name, his]) => [normalizeName(name), his]));

describe("a player the injury report says is not playing", () => {
  const chase = normalizeName("Ja'Marr Chase");

  it("reads zero on every figure", () => {
    const rows = withOutPlayersZeroed(rowsOf(built), listedBy({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "Out", part: "hip" },
    }));
    const row = rows.get(chase)!;

    expect(row.ours).toBe(0);
    expect(row.sleeper).toBe(0);
    expect(row.blend).toBe(0);
    expect(row.floor).toBe(0);
    expect(row.q1).toBe(0);
    expect(row.q3).toBe(0);
    expect(row.ceiling).toBe(0);
  });

  it("keeps his name, his side and his fixture, so a page can still draw him", () => {
    const rows = withOutPlayersZeroed(rowsOf(built), listedBy({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "IR" },
    }));
    const row = rows.get(chase)!;

    expect(row.name).toBe("Ja'Marr Chase");
    expect(row.team).toBe("CIN");
    expect(row.opponent).toBe("TB");
  });

  it("leaves everybody else where he was", () => {
    const rows = withOutPlayersZeroed(rowsOf(built), listedBy({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "Out" },
    }));

    expect(rows.get(normalizeName("Joe Burrow"))!.blend).toBe(18);
  });

  it("does not rule a player out over a namesake at another position", () => {
    const rows = withOutPlayersZeroed(rowsOf(built), listedBy({
      "Ja'Marr Chase": {
        name: "Ja'Marr Chase", status: "Out", position: "LB", team: "CLE",
      },
    }));

    expect(rows.get(chase)!.blend).toBeGreaterThan(0);
  });

  it("hands back the same map when nobody is out", () => {
    const rows = rowsOf(built);

    expect(withOutPlayersZeroed(rows, new Map())).toBe(rows);
  });

  /**
   * Kickers and defences are not in a slate at all, and without a row of
   * zeros a kicker on the injury report drew the position's stock week.
   */
  it("writes a zero row for a player the slate never had", () => {
    const rows = withOutPlayersZeroed(rowsOf(built), listedBy({
      "Harrison Butker": {
        name: "Harrison Butker", status: "Out", position: "K", team: "KC",
      },
    }));
    const line = lineOf(normalizeName("Harrison Butker"), rows, undefined, "K");

    expect(line!.blend).toBe(0);
    expect(line!.spread.high).toBe(0);
    expect(line!.stock).toBe(false);
  });

  it("leaves a player out with no position said for him to the board", () => {
    const rows = withOutPlayersZeroed(rowsOf(built), listedBy({
      "Somebody Nobody Knows": { name: "Somebody Nobody Knows", status: "Out" },
    }));

    expect(rows.has(normalizeName("Somebody Nobody Knows"))).toBe(false);
  });

  it("draws a flat zero week rather than his ladder", () => {
    const rows = withOutPlayersZeroed(rowsOf(built), listedBy({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "Out" },
    }));
    const live = liveDraws(
      [{ key: chase }], rows, new Map(), 50,
    );

    expect(spreadOf(rows.get(chase)!).high).toBe(0);
    expect(live.toCome(chase).every((week) => week === 0)).toBe(true);
  });

  /** he limped off at halftime, and the half he played still counts */
  it("keeps what he has already scored", () => {
    const rows = withOutPlayersZeroed(rowsOf(built), listedBy({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "Out" },
    }));
    const live = liveDraws(
      [{ key: chase, points: 6.4 }],
      rows,
      new Map([["CIN", { where: "in" as const, left: 0.5 }]]),
      50,
    );
    const drawn = live.drawingOf(chase)!;

    expect(drawn.scored).toBe(6.4);
    expect(drawn.week.every((week) => week === 0)).toBe(true);
  });
});

/**
 * About two thirds of questionable players have played, so the rest of
 * his projection is a third of his week that never happens.
 */
describe("a player the injury report is unsure about", () => {
  const chase = normalizeName("Ja'Marr Chase");

  const asked = (status: string) => withOutPlayersZeroed(
    rowsOf(built), listedBy({ "Ja'Marr Chase": { name: "Ja'Marr Chase", status } }),
  ).get(chase)!;

  it("takes a third off a questionable player's three projections", () => {
    const row = asked("Questionable");

    expect(row.ours).toBe(10.9);
    expect(row.sleeper).toBe(10.9);
    expect(row.blend).toBe(10.9);
    expect(row.playChance).toBeCloseTo(0.64);
  });

  it("puts the bottom of his week at zero, since he may not play", () => {
    const row = asked("Questionable");

    expect(row.floor).toBe(0);
    expect(row.q1).toBe(0);
  });

  it("leaves the top of his week where a played week had it", () => {
    const row = asked("Questionable");

    expect(row.q3).toBe(22);
    expect(row.ceiling).toBe(28);
  });

  it("prices a doubtful player at nearly nothing", () => {
    const row = asked("Doubtful");

    expect(row.blend).toBeLessThan(1);
    expect(row.ceiling).toBe(28);
  });

  it("leaves everybody else where he was", () => {
    const rows = withOutPlayersZeroed(rowsOf(built), listedBy({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "Questionable" },
    }));

    expect(rows.get(normalizeName("Joe Burrow"))!.blend).toBe(18);
  });

  /** the build's flag is a week old by Sunday, so a live word wins */
  it("takes the league's word over the one the build wrote down", () => {
    const listed = readSlate({
      season: 2026,
      week: 1,
      perCatch: 0.5,
      players: [{
        name: "Ja'Marr Chase", position: "WR", team: "CIN", opponent: "v TB",
        ours: 17, sleeper: 17, average: 17, floor: 9, ceiling: 28,
        q1: 12, q3: 22, catches: 6, questionable: true,
      }],
    });

    const back = withOutPlayersZeroed(rowsOf(listed), listedBy({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "Out" },
    })).get(chase)!;

    expect(back.blend).toBe(0);
    expect(back.ceiling).toBe(0);
  });

  it("keeps a doubtful player's word on his row through the read", () => {
    const flagged = readSlate({
      season: 2026,
      week: 2,
      perCatch: 0.5,
      players: [{
        name: "Zay Flowers", position: "WR", team: "BAL", opponent: "v CLE",
        ours: 0, sleeper: 0, average: 0, floor: 0, ceiling: 0,
        q1: 0, q3: 0, catches: 4, ruledOut: true, status: "Doubtful",
      }],
    });

    expect(flagged.rows[0]!.ruledOut).toBe(true);
    expect(flagged.rows[0]!.status).toBe("Doubtful");
  });

  /**
   * A designation landing on Saturday can sit in the league's own player
   * file for a day, and the build's word is the only one we have until it
   * catches up.
   */
  it("holds a ruled out player at zero when the league has said nothing", () => {
    const flowers = normalizeName("Zay Flowers");
    const flagged = readSlate({
      season: 2026,
      week: 2,
      perCatch: 0.5,
      players: [{
        name: "Zay Flowers", position: "WR", team: "BAL", opponent: "v CLE",
        ours: 14, sleeper: 13, average: 13.5, floor: 7, ceiling: 24,
        q1: 10, q3: 18, catches: 4, ruledOut: true, status: "Doubtful",
      }],
    });
    const rows = withOutPlayersZeroed(rowsOf(flagged), new Map());
    const row = rows.get(flowers)!;
    const live = liveDraws([{ key: flowers }], rows, new Map(), 50);

    expect(row.blend).toBe(0);
    expect(row.ceiling).toBe(0);
    expect(row.playChance).toBe(0);
    expect(lineOf(flowers, rows)!.blend).toBe(0);
    expect(live.toCome(flowers).every((week) => week === 0)).toBe(true);
  });

  it("marks down a player only the build had listed", () => {
    const listed = readSlate({
      season: 2026,
      week: 1,
      perCatch: 0.5,
      players: [{
        name: "Ja'Marr Chase", position: "WR", team: "CIN", opponent: "v TB",
        ours: 17, sleeper: 17, average: 17, floor: 9, ceiling: 28,
        q1: 12, q3: 22, catches: 6, questionable: true,
      }],
    });

    const back = withOutPlayersZeroed(rowsOf(listed), new Map()).get(chase)!;

    expect(back.blend).toBe(10.9);
    expect(back.playChance).toBeCloseTo(0.64);
  });
});

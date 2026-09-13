import { describe, expect, it } from "vitest";

import type { Listed } from "./availability.ts";
import { lineOf, liveDraws, spreadOf } from "./matchups.ts";
import { readSlate, slateUnder, withOutMenZeroed } from "./slate.ts";
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

  it("leaves a man with no catches, and a missing figure, alone", () => {
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

const office = (men: Record<string, Listed>) =>
  new Map(Object.entries(men).map(([name, his]) => [normalizeName(name), his]));

describe("a man the league office says is not playing", () => {
  const chase = normalizeName("Ja'Marr Chase");

  it("reads nought on every figure", () => {
    const rows = withOutMenZeroed(rowsOf(built), office({
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
    const rows = withOutMenZeroed(rowsOf(built), office({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "IR" },
    }));
    const row = rows.get(chase)!;

    expect(row.name).toBe("Ja'Marr Chase");
    expect(row.team).toBe("CIN");
    expect(row.opponent).toBe("TB");
  });

  it("leaves everybody else where he was", () => {
    const rows = withOutMenZeroed(rowsOf(built), office({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "Out" },
    }));

    expect(rows.get(normalizeName("Joe Burrow"))!.blend).toBe(18);
  });

  it("leaves a questionable man alone", () => {
    const rows = rowsOf(built);

    expect(withOutMenZeroed(rows, office({
      "Ja'Marr Chase": { name: "Ja'Marr Chase", status: "Questionable" },
    }))).toBe(rows);
  });

  it("hands back the same map when nobody is out", () => {
    const rows = rowsOf(built);

    expect(withOutMenZeroed(rows, new Map())).toBe(rows);
  });

  /**
   * Kickers and defences are not in a slate at all, and without a row of
   * noughts a kicker on the injury report drew the position's stock week.
   */
  it("writes a nought row for a man the slate never had", () => {
    const rows = withOutMenZeroed(rowsOf(built), office({
      "Harrison Butker": {
        name: "Harrison Butker", status: "Out", position: "K", team: "KC",
      },
    }));
    const line = lineOf(normalizeName("Harrison Butker"), rows, undefined, "K");

    expect(line!.blend).toBe(0);
    expect(line!.spread.high).toBe(0);
    expect(line!.stock).toBe(false);
  });

  it("leaves a man out with no position said for him to the board", () => {
    const rows = withOutMenZeroed(rowsOf(built), office({
      "Somebody Nobody Knows": { name: "Somebody Nobody Knows", status: "Out" },
    }));

    expect(rows.has(normalizeName("Somebody Nobody Knows"))).toBe(false);
  });

  it("draws a flat nought week rather than his ladder", () => {
    const rows = withOutMenZeroed(rowsOf(built), office({
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
    const rows = withOutMenZeroed(rowsOf(built), office({
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

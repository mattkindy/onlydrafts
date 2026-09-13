/**
 * The browser engine, against the tables the site ships.
 *
 * The full check asks the Node simulator the same questions off a
 * season of checkpoints, and it wants the raw play by play. So what
 * runs here is the cheap half: one recognisable game, played twice.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { leagueOf, remainderFor, type RemainderState } from "./remainder.ts";
import {
  DIST_BANDS, MARGIN_BANDS, TIME_BANDS, type SimTables,
} from "./simTables.ts";

const PATH = "docs/data/sim-2025.json";
const PPR = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6,
  rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2, rush_2pt: 2,
};

const mean = (its: Float64Array) => {
  let sum = 0;

  for (const one of its) {
    sum += one;
  }

  return its.length ? sum / its.length : 0;
};

describe.skipIf(!existsSync(PATH))("the rest of a game, played in the browser", () => {
  const tables = JSON.parse(readFileSync(PATH, "utf8")) as SimTables;
  const league = leagueOf(tables);
  const teams = Object.keys(tables.teams);
  const [home, away] = [teams[0]!, teams[1]!];
  const atHalf: RemainderState = {
    home, away,
    points: { [home]: 14, [away]: 10 },
    secondsLeft: 1800,
    withBall: home, yardline: 70, down: 1, toGo: 10,
    timeouts: { [home]: 3, [away]: 3 },
    warningLeft: true, secondHalf: true,
  };

  /**
   * A table built against an older layout reads short, and the engine
   * would take the missing bytes for a zero and punt every fourth down
   * without saying so. The shape is checked instead.
   */
  it("ships a fourth down table the engine's indexing fits", () => {
    expect(league.fourth.length)
      .toBe(99 * DIST_BANDS * MARGIN_BANDS * TIME_BANDS * 2);
  });

  it("gives a half's worth of points to each side", () => {
    const played = remainderFor(tables, league, atHalf, 400, PPR, 11)!;

    for (const team of [home, away]) {
      const left = mean(played.teamPoints[team]!);
      expect(left).toBeGreaterThan(4);
      expect(left).toBeLessThan(20);
    }
  });

  it("answers the same twice off the same seed", () => {
    const first = remainderFor(tables, league, atHalf, 100, PPR, 7)!;
    const again = remainderFor(tables, league, atHalf, 100, PPR, 7)!;
    const key = [...first.players.keys()][0]!;

    expect([...again.players.get(key)!]).toEqual([...first.players.get(key)!]);
  });

  it("gives a side's players between them about what the side scores", () => {
    const played = remainderFor(tables, league, atHalf, 400, PPR, 3)!;
    const his = tables.teams[home]!.men
      .map((player) => mean(played.players.get(player.key) ?? new Float64Array(1)))
      .reduce((sum, points) => sum + points, 0);

    expect(his).toBeGreaterThan(mean(played.teamPoints[home]!));
  });

  /**
   * The two men picked are the side's busiest runners or catchers other
   * than the last in its list, who is the one the engine falls back on
   * when a block of shares adds to nothing.
   */
  const busiest = (played: ReturnType<typeof remainderFor>, count: number) => {
    const men = tables.teams[home]!.men;

    return men.slice(0, -1)
      .filter((man) => man.position !== "QB")
      .sort((a, b) => mean(played!.players.get(b.key)!) -
        mean(played!.players.get(a.key)!))
      .slice(0, count);
  };

  it("hands the snaps of a player ruled out to his teammates", () => {
    const before = remainderFor(tables, league, atHalf, 400, PPR, 21)!;
    const [gone, mate] = busiest(before, 2);
    const after = remainderFor(
      tables, league, { ...atHalf, shareScale: { [gone!.key]: 0 } },
      400, PPR, 21)!;

    expect(mean(after.players.get(gone!.key)!)).toBe(0);
    expect(mean(after.players.get(mate!.key)!))
      .toBeGreaterThan(mean(before.players.get(mate!.key)!));
  });

  it("leaves a player questionable to return about half of what he had", () => {
    const before = remainderFor(tables, league, atHalf, 600, PPR, 23)!;
    const [iffy] = busiest(before, 1);
    const after = remainderFor(
      tables, league, { ...atHalf, shareScale: { [iffy!.key]: 0.5 } },
      600, PPR, 23)!;
    const share = mean(after.players.get(iffy!.key)!) /
      mean(before.players.get(iffy!.key)!);

    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.75);
  });

  it("has nothing left for a game that is over", () => {
    const played = remainderFor(
      tables, league, { ...atHalf, secondsLeft: 0 }, 20, PPR, 5)!;

    expect(mean(played.teamPoints[home]!)).toBe(0);
  });
});

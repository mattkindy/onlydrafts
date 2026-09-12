/**
 * The browser engine, against the tables the site ships.
 *
 * The full check is scripts/simAgreement.ts, which asks the Node
 * simulator the same questions off a season of checkpoints. That wants
 * the raw play by play, so what runs here is the cheap half: the engine
 * plays a recognisable game and gives the same answer twice.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { leagueOf, remainderFor, type RemainderState } from "./remainder.ts";
import type { SimTables } from "./simTables.ts";

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
    const key = [...first.men.keys()][0]!;

    expect([...again.men.get(key)!]).toEqual([...first.men.get(key)!]);
  });

  it("gives a side's men between them about what the side scores", () => {
    const played = remainderFor(tables, league, atHalf, 400, PPR, 3)!;
    const his = tables.teams[home]!.men
      .map((man) => mean(played.men.get(man.key) ?? new Float64Array(1)))
      .reduce((sum, points) => sum + points, 0);

    expect(his).toBeGreaterThan(mean(played.teamPoints[home]!));
  });

  it("has nothing left for a game that is over", () => {
    const played = remainderFor(
      tables, league, { ...atHalf, secondsLeft: 0 }, 20, PPR, 5)!;

    expect(mean(played.teamPoints[home]!)).toBe(0);
  });
});

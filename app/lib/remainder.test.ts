/**
 * The browser engine, against the tables the site ships.
 *
 * The full check asks the Node simulator the same questions off a
 * season of checkpoints, and it wants the raw play by play. So what
 * runs here is the cheap half: one recognisable game, played twice.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  defenceKeyOf, leagueOf, remainderFor, type RemainderState,
} from "./remainder.ts";
import {
  bytesOf, DIST_BANDS, MARGIN_BANDS, TIME_BANDS, type SimTables,
} from "./simTables.ts";

const PATH = "docs/data/sim-2025.json";
const PPR = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6,
  rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2, rush_2pt: 2,
};

/** the same league, with what it pays a defence spelled out */
const DEFENCE = {
  ...PPR,
  sack: 1, int: 2, fum_rec: 2, def_td: 6, safe: 2, blk_kick: 2,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};

const BUCKET: [number, string][] = [
  [0, "pts_allow_0"], [6, "pts_allow_1_6"], [13, "pts_allow_7_13"],
  [20, "pts_allow_14_20"], [27, "pts_allow_21_27"], [34, "pts_allow_28_34"],
];

const bucketPay = (allowed: number, pays: Record<string, number>) =>
  pays[BUCKET.find(([top]) => allowed <= top)?.[1] ?? "pts_allow_35p"] ?? 0;

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

  /** the same man the engine picks: the most work in the shares table */
  const busiestAt = (positions: string[]) => {
    const men = tables.teams[home]!.men;
    const shares = bytesOf(tables.teams[home]!.shares);
    const totals = men.map(() => 0);

    for (let at = 0; at < shares.length; at++) {
      const i = at % men.length;
      totals[i] = totals[i]! + shares[at]!;
    }

    return men
      .filter((man) => positions.includes(man.position))
      .sort((a, b) => totals[men.indexOf(b)]! - totals[men.indexOf(a)]!)[0]!;
  };

  const inTheFourth = (lead: number, week?: number): RemainderState => ({
    ...atHalf,
    points: { [home]: 24, [away]: 24 - lead },
    secondsLeft: 800,
    ...(week === undefined ? {} : { week }),
  });

  const meanFor = (state: RemainderState, key: string, draws = 600) =>
    mean(remainderFor(tables, league, state, draws, PPR, 31)!.players.get(key)!);

  it("takes the top back off in a lopsided fourth quarter", () => {
    const back = busiestAt(["RB", "FB"]).key;

    expect(meanFor(inTheFourth(21), back))
      .toBeLessThan(meanFor(inTheFourth(3), back) * 0.8);
  });

  it("leaves a close fourth quarter alone, whatever the week", () => {
    const back = busiestAt(["RB", "FB"]).key;
    const early = remainderFor(tables, league, inTheFourth(3, 8), 200, PPR, 9)!;
    const late = remainderFor(tables, league, inTheFourth(3, 15), 200, PPR, 9)!;

    expect([...late.players.get(back)!]).toEqual([...early.players.get(back)!]);
  });

  it("rests starters harder once the standings have settled", () => {
    const back = busiestAt(["RB", "FB"]).key;

    expect(meanFor(inTheFourth(21, 15), back))
      .toBeLessThan(meanFor(inTheFourth(21, 8), back));
  });

  /**
   * A draw that started with the back already off would hand every later
   * draw the same, and the whole run would read near zero. Comparing the
   * first fifty draws with the last fifty catches that.
   */
  it("puts the starters back on for each draw", () => {
    const back = busiestAt(["RB", "FB"]).key;
    const blowout = inTheFourth(21);
    const played = remainderFor(tables, league, blowout, 400, PPR, 31)!;
    const his = played.players.get(back)!;
    const first = mean(his.slice(0, 50));
    const last = mean(his.slice(-50));

    expect(last).toBeGreaterThan(first * 0.5);
    expect(last).toBeLessThan(first * 2);

    const again = remainderFor(tables, league, blowout, 400, PPR, 31)!;
    expect([...again.players.get(back)!]).toEqual([...his]);
  });

  /**
   * Both margins are the same band to every fitted table, so what is
   * left between them is the twenty percent already off at seventeen.
   * Half a minute leaves the per-snap hazards little room, so the back
   * should keep about four fifths of what he keeps at sixteen.
   */
  it("starts a lopsided fourth quarter with a fifth of them already off", () => {
    const back = busiestAt(["RB", "FB"]).key;
    const wide = { ...inTheFourth(-21), secondsLeft: 30 };
    const narrow = { ...inTheFourth(-16), secondsLeft: 30 };
    const share = meanFor(wide, back, 3000) / meanFor(narrow, back, 3000);

    expect(share).toBeGreaterThan(0.6);
    expect(share).toBeLessThan(0.95);
  });

  /** level with the clock out, so every draw plays an overtime period */
  const atTheWhistle: RemainderState = {
    ...atHalf,
    points: { [home]: 20, [away]: 20 },
    secondsLeft: 0,
    withBall: undefined,
    yardline: undefined,
    down: undefined,
    toGo: undefined,
    week: 8,
  };

  const sides = (state: RemainderState, draws: number, seed: number) => {
    const played = remainderFor(tables, league, state, draws, PPR, seed)!;

    return { played, home: played.teamPoints[home]!, away: played.teamPoints[away]! };
  };

  it("puts overtime points on the players who scored them", () => {
    const { played, home: mine, away: theirs } = sides(atTheWhistle, 600, 41);
    const scored = [...played.players.values()]
      .reduce((sum, its) => sum + mean(its), 0);

    expect(mean(mine) + mean(theirs)).toBeGreaterThan(2);
    expect(scored).toBeGreaterThan(mean(mine) + mean(theirs));
  });

  it("draws more than nothing for a game already in overtime", () => {
    const live: RemainderState = {
      ...atTheWhistle,
      overtimeLeft: 240,
      withBall: home, yardline: 70, down: 1, toGo: 10,
    };
    const { played } = sides(live, 400, 43);
    const scored = [...played.players.values()]
      .reduce((sum, its) => sum + mean(its), 0);

    expect(scored).toBeGreaterThan(1);
  });

  /**
   * Both sides get the ball and then the next score ends it, so the most
   * one side can lead by is a touchdown and the kick after it.
   */
  it("stops overtime at the first score once both sides have had the ball", () => {
    const { home: mine, away: theirs } = sides(atTheWhistle, 1200, 47);

    for (let draw = 0; draw < mine.length; draw++) {
      expect(Math.abs(mine[draw]! - theirs[draw]!)).toBeLessThanOrEqual(7);
    }
  });

  const tieRate = (state: RemainderState, draws: number, seed: number) => {
    const { home: mine, away: theirs } = sides(state, draws, seed);
    let tied = 0;

    for (let draw = 0; draw < draws; draw++) {
      if (mine[draw] === theirs[draw]) {
        tied++;
      }
    }

    return tied / draws;
  };

  it("can still end a regular season game tied", () => {
    const rate = tieRate(atTheWhistle, 1200, 53);

    expect(rate).toBeGreaterThan(0.01);
    expect(rate).toBeLessThan(0.3);
  });

  it("plays on until somebody leads in a playoff game", () => {
    expect(tieRate({ ...atTheWhistle, week: 20 }, 600, 53)).toBe(0);
  });

  it("has nothing left for a game that is over", () => {
    const played = remainderFor(
      tables, league, { ...atHalf, secondsLeft: 0 }, 20, PPR, 5)!;

    expect(mean(played.teamPoints[home]!)).toBe(0);
  });

  describe("a defence in a live game", () => {
    const atKickoff: RemainderState = {
      home, away,
      points: { [home]: 0, [away]: 0 },
      secondsLeft: 3600,
      timeouts: { [home]: 3, [away]: 3 },
      warningLeft: true, secondHalf: false, week: 8,
    };
    const key = defenceKeyOf(home);

    /** what a league pays a defence for the score alone */
    const bucketOnly = {
      ...DEFENCE,
      sack: 0, int: 0, fum_rec: 0, def_td: 0, safe: 0, blk_kick: 0,
    };

    it("is worth about a stock week at kickoff, not a shutout and a week", () => {
      const played = remainderFor(tables, league, atKickoff, 600, DEFENCE, 21)!;
      // a shutout is what the provider has paid so far, so the projection
      // is that plus whatever the draws add
      const projected = DEFENCE.pts_allow_0 + mean(played.players.get(key)!);

      expect(projected).toBeGreaterThan(2);
      expect(projected).toBeLessThan(11);
    });

    it("leaves a defence three scores down near what it has earned", () => {
      const late: RemainderState = {
        ...atHalf,
        points: { [home]: 10, [away]: 21 },
        secondsLeft: 300,
        withBall: away, yardline: 60, down: 1, toGo: 10,
      };
      const played = remainderFor(tables, league, late, 600, DEFENCE, 21)!;

      expect(Math.abs(mean(played.players.get(key)!))).toBeLessThan(2);
    });

    it("pays the points allowed bucket once, at the score it finishes on", () => {
      const played =
        remainderFor(tables, league, atKickoff, 200, bucketOnly, 21)!;
      const its = played.players.get(key)!;

      for (let draw = 0; draw < its.length; draw++) {
        const allowed = played.teamPoints[away]![draw]!;

        // what the provider has paid so far is the shutout it is on
        expect(bucketOnly.pts_allow_0 + its[draw]!)
          .toBeCloseTo(bucketPay(allowed, bucketOnly), 6);
      }
    });
  });
});

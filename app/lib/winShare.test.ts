/**
 * The cases value over replacement gets wrong, which is why this exists.
 *
 * An empty seat, a fifth back nobody would start, and a kicker you
 * already have. Points over a baseline says the same thing about the
 * second and the third of those; how often you win a week does not.
 */

import { describe, expect, it } from "vitest";

import {
  baselineFor, weeksOf, winChance, winShareFor,
} from "./winShare.ts";
import type { Player } from "./scoring.ts";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];

/** a man who scores about this much a week, with an ordinary spread */
const aMan = (
  name: string, position: string, ppg: number, games = 17,
): Player => ({
  name, key: name, position, games, ppg,
  game: {
    ev: ppg, mid: ppg, q1: ppg * 0.7, q3: ppg * 1.3,
    low: ppg * 0.4, high: ppg * 1.7,
  },
}) as Player;

const aRoster = () => [
  aMan("qb", "QB", 18), aMan("rb1", "RB", 15), aMan("rb2", "RB", 12),
  aMan("wr1", "WR", 14), aMan("wr2", "WR", 11), aMan("te", "TE", 9),
  aMan("flex", "WR", 10),
];

/** a side that scores about what ours does, so the comparison is live */
const anOpponent = (draws = 400) => {
  const men = [
    aMan("theirQb", "QB", 18), aMan("theirRb1", "RB", 15),
    aMan("theirRb2", "RB", 12), aMan("theirWr1", "WR", 14),
    aMan("theirWr2", "WR", 11), aMan("theirTe", "TE", 9),
    aMan("theirFlex", "WR", 10), aMan("theirK", "K", 9),
  ];
  const weeks = men.map((p) => weeksOf(p, draws));

  return Array.from({ length: draws }, (_, i) =>
    weeks.reduce((sum, its) => sum + its[i]!, 0));
};

const DRAWN = 400;

describe("a seat you have not filled", () => {
  it("is worth the whole of the first man who fills it", () => {
    const roster = aRoster();
    const baseline = baselineFor(roster, SLOTS, DRAWN);
    const worth = winShareFor(baseline, anOpponent(DRAWN), DRAWN);

    // nobody on this roster kicks, so the seat scores nothing
    expect(worth(aMan("k1", "K", 9)).starts).toBeGreaterThan(0.9);
    expect(worth(aMan("k1", "K", 9)).added).toBeGreaterThan(0.1);
  });

  it("and almost nothing to the second one", () => {
    const withOne = aRoster().concat(aMan("k1", "K", 9));
    const worth = winShareFor(
      baselineFor(withOne, SLOTS, DRAWN), anOpponent(DRAWN), DRAWN,
    );
    const second = worth(aMan("k2", "K", 8.8));

    expect(second.added).toBeLessThan(0.02);
  });
});

describe("depth", () => {
  /**
   * A back who cannot crack the lineup this Sunday still plays, because
   * the men ahead of him have byes and get hurt. On the weeks they are
   * out he is the best flex left, and that is what depth is worth.
   *
   * He has to be good enough to be next in line. A fifth back nobody
   * would ever start over the fourth is worth nothing, and the model
   * saying so is correct rather than a hole in it.
   */
  it("is worth something to a man who would not start today", () => {
    const deep = aRoster().concat(
      aMan("rb3", "RB", 12, 11), aMan("rb4", "RB", 9),
    );
    const worth = winShareFor(
      baselineFor(deep, SLOTS, DRAWN), anOpponent(DRAWN), DRAWN,
    );
    const next = worth(aMan("rb5", "RB", 10.5));

    expect(next.starts).toBeGreaterThan(0);
    expect(next.starts).toBeLessThan(1);
  });

  it("is worth less than the same man on a thin roster", () => {
    const thin = [aMan("qb", "QB", 18), aMan("rb1", "RB", 15)];
    const deep = aRoster().concat(
      aMan("rb3", "RB", 12, 11), aMan("rb4", "RB", 9),
    );
    const him = aMan("rb5", "RB", 10.5);

    const onThin = winShareFor(
      baselineFor(thin, SLOTS, DRAWN), anOpponent(DRAWN), DRAWN,
    )(him);
    const onDeep = winShareFor(
      baselineFor(deep, SLOTS, DRAWN), anOpponent(DRAWN), DRAWN,
    )(him);

    // how often he plays, and not what that is worth: a two man roster
    // loses every week whoever you add to it
    expect(onThin.starts).toBeGreaterThan(onDeep.starts);
  });

  it("gives nothing to a man who would never be started", () => {
    const deep = aRoster().concat(
      aMan("rb3", "RB", 12), aMan("rb4", "RB", 11),
    );
    const worth = winShareFor(
      baselineFor(deep, SLOTS, DRAWN), anOpponent(DRAWN), DRAWN,
    );

    expect(worth(aMan("rb6", "RB", 4)).starts).toBe(0);
  });
});

describe("a man who misses weeks", () => {
  it("starts fewer of them than the same man who does not", () => {
    const baseline = baselineFor(aRoster(), SLOTS, DRAWN);
    const worth = winShareFor(baseline, anOpponent(DRAWN), DRAWN);

    const whole = worth(aMan("fit", "TE", 14, 17));
    const half = worth(aMan("fragile", "TE", 14, 9));

    expect(half.starts).toBeLessThan(whole.starts);
    expect(half.added).toBeLessThan(whole.added);
  });
});

describe("winChance", () => {
  it("counts the weeks one side outscores the other", () => {
    expect(winChance([10, 10, 10], [9, 11, 9])).toBeCloseTo(2 / 3, 5);
    expect(winChance([1, 1], [2, 2])).toBe(0);
  });
});

/**
 * A point is worth most when the week is close. It buys nothing on a
 * side that loses whatever happens and nothing on one that wins
 * whatever happens, which is the thing points over a baseline cannot
 * say and the reason for measuring in wins at all.
 */
describe("what a point is worth depends on the week", () => {
  const him = aMan("adding", "TE", 12);

  const worthOn = (roster: Player[]) =>
    winShareFor(
      baselineFor(roster, SLOTS, DRAWN), anOpponent(DRAWN), DRAWN,
    )(him).added;

  it("pays more on an even side than a hopeless one", () => {
    const hopeless = [aMan("qb", "QB", 6), aMan("rb1", "RB", 4)];

    expect(worthOn(aRoster())).toBeGreaterThan(worthOn(hopeless));
  });

  it("and more than on one that wins anyway", () => {
    const runaway = [
      aMan("qb", "QB", 40), aMan("rb1", "RB", 40), aMan("rb2", "RB", 40),
      aMan("wr1", "WR", 40), aMan("wr2", "WR", 40), aMan("te1", "TE", 40),
      aMan("fl", "WR", 40), aMan("k", "K", 40), aMan("d", "DEF", 40),
    ];

    expect(worthOn(aRoster())).toBeGreaterThan(worthOn(runaway));
  });
});

/**
 * The cases value over replacement gets wrong, which is why this exists.
 *
 * An empty seat, a fifth back nobody would start, and a kicker you
 * already have. Points over a baseline says the same thing about the
 * second and the third of those; how often you win a week does not.
 */

import { describe, expect, it } from "vitest";

import {
  baselineFor, projectedRoster, takeNowFor, weeksOf, winChance,
  winShareFor,
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

  /**
   * You do not field eight men. Whatever your roster cannot cover, you
   * cover off waivers, so the first kicker is worth what he beats the
   * kicker anybody can have by, and a backup quarterback covers the
   * weeks your starter is out against that same man rather than
   * against nothing.
   */
  it("costs the man off waivers once the wire is given", () => {
    const roster = aRoster();
    const opponent = anOpponent(DRAWN);
    const wire = { K: 8.5, QB: 16 };
    const onNothing = winShareFor(
      baselineFor(roster, SLOTS, DRAWN), opponent, DRAWN,
    );
    const onTheWire = winShareFor(
      baselineFor(roster, SLOTS, DRAWN, wire), opponent, DRAWN,
    );
    const him = aMan("k1", "K", 9);

    expect(onTheWire(him).added).toBeLessThan(onNothing(him).added / 2);
  });

  it("pays a second quarterback for the weeks the first is out, no more", () => {
    const opponent = anOpponent(DRAWN);
    const roster = aRoster().concat(aMan("k1", "K", 9));
    // his own man plays two thirds of the weeks
    const starter = aMan("qb1", "QB", 24, 11);
    const wire = { QB: 22.5 };
    const backup = aMan("qb2", "QB", 24);
    const withQb = roster.filter((p) => p.position !== "QB").concat(starter);
    const onNothing = winShareFor(
      baselineFor(withQb, SLOTS, DRAWN), opponent, DRAWN,
    )(backup);
    const onTheWire = winShareFor(
      baselineFor(withQb, SLOTS, DRAWN, wire), opponent, DRAWN,
    )(backup);

    expect(onNothing.added).toBeGreaterThan(0.01);
    expect(onTheWire.added).toBeLessThan(onNothing.added / 2);
    // and the seat is no longer worth nothing in the weeks it is empty
    expect(onTheWire.starts).toBeCloseTo(onNothing.starts, 10);
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

/**
 * The flex is shared, and who a newcomer pushes out of it is settled by
 * the drawn week rather than by any pencil assignment. On a roster with
 * three good backs and two poor receivers the flex goes to a back, so
 * a new back has to beat far more than a new receiver does. That gap is
 * what the roster says, not an artifact: putting either man on and
 * drawing the whole lineup again drops exactly the man the bar named.
 */
describe("the bar at a shared seat", () => {
  const shared = () => [
    aMan("rb1", "RB", 19.8), aMan("rb2", "RB", 17.6), aMan("rb3", "RB", 14.8),
    aMan("wr1", "WR", 10.5), aMan("wr2", "WR", 9.5), aMan("te1", "TE", 10.5),
    aMan("qb1", "QB", 24.6), aMan("k1", "K", 9), aMan("d1", "DEF", 8),
  ];

  it("is the man the week put in the flex, not the one a pencil put there", () => {
    const base = baselineFor(shared(), SLOTS, DRAWN);

    // nobody here misses a week, so every week seats the same men
    expect(base.displaced["RB"]![0]!.expect).toBe(14.8);
    expect(base.displaced["WR"]![0]!.expect).toBe(9.5);
    expect(base.displaced["TE"]![0]!.expect).toBe(10.5);
  });

  it("names the man the lineup actually drops, at every position", () => {
    const opponent = anOpponent(DRAWN);
    const roster = shared();
    const worth = winShareFor(
      baselineFor(roster, SLOTS, DRAWN), opponent, DRAWN,
    );
    const passed = winChance(baselineFor(roster, SLOTS, DRAWN).total, opponent);
    const newcomers = [
      aMan("newRb", "RB", 16), aMan("cheapRb", "RB", 12),
      aMan("newWr", "WR", 20), aMan("cheapWr", "WR", 12),
      aMan("newTe", "TE", 15),
    ];

    for (const him of newcomers) {
      const drawn = winChance(
        baselineFor([...roster, him], SLOTS, DRAWN).total, opponent,
      );

      expect(worth(him).added).toBeCloseTo(drawn - passed, 10);
    }
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

/**
 * Two things the raw change in win chance cannot do on its own, and the
 * projected roster fixes both.
 */
describe("against the side you would have finished with", () => {
  const board = [
    aMan("elite", "RB", 22), aMan("good", "RB", 16), aMan("okay", "RB", 12),
    aMan("thin", "RB", 8), aMan("wr1", "WR", 20), aMan("wr2", "WR", 15),
    aMan("wr3", "WR", 12), aMan("wr4", "WR", 10), aMan("wr5", "WR", 9),
    aMan("qb1", "QB", 22), aMan("qb2", "QB", 18), aMan("te1", "TE", 13),
    aMan("te2", "TE", 10), aMan("k1", "K", 9.4), aMan("k2", "K", 9.2),
    aMan("d1", "DEF", 8.5), aMan("d2", "DEF", 8.2),
  ].map((p, i) => ({ ...p, adp: i + 1, vor: 200 - i * 10 })) as Player[];

  const turns = [1, 5, 9, 13, 16];

  it("fills the seats you have not drafted yet", () => {
    const projected = projectedRoster([], SLOTS, board, turns);

    expect(projected.length).toBe(turns.length);
    // and only with men you could still expect to be there
    for (const p of projected) {
      expect(p.adp).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * A seat a late round fills nearly as well is worth little now. Every
   * kicker is much the same, so taking one early buys almost nothing;
   * the backs run out, so the best one is worth a great deal.
   */
  it("prices a seat by what you would get there later", () => {
    const projected = projectedRoster([], SLOTS, board, turns);
    const worth = winShareFor(
      baselineFor(projected, SLOTS, DRAWN), anOpponent(DRAWN), DRAWN,
    );

    expect(worth(board.find((p) => p.name === "elite")!).added)
      .toBeGreaterThan(worth(board.find((p) => p.name === "k1")!).added);
  });

  it("says something about the first pick, where a bare roster cannot", () => {
    const onNothing = winShareFor(
      baselineFor([], SLOTS, DRAWN), anOpponent(DRAWN), DRAWN,
    );
    const onProjected = winShareFor(
      baselineFor(projectedRoster([], SLOTS, board, turns), SLOTS, DRAWN),
      anOpponent(DRAWN),
      DRAWN,
    );
    const him = board.find((p) => p.name === "elite")!;

    // one man against a whole side loses every week, so the bare
    // version reads nought for the best player in the draft
    expect(onNothing(him).added).toBe(0);
    expect(onProjected(him).added).toBeGreaterThan(0);
  });
});

describe("taking a man now, with the rest of the draft filled around him", () => {
  const board = [
    aMan("elite", "RB", 22), aMan("good", "RB", 16), aMan("okay", "RB", 12),
    aMan("thin", "RB", 8), aMan("wr1", "WR", 20), aMan("wr2", "WR", 15),
    aMan("wr3", "WR", 12), aMan("wr4", "WR", 10), aMan("wr5", "WR", 9),
    aMan("qb1", "QB", 22), aMan("qb2", "QB", 18), aMan("te1", "TE", 13),
    aMan("te2", "TE", 10), aMan("k1", "K", 9.4), aMan("k2", "K", 9.2),
    aMan("d1", "DEF", 8.5), aMan("d2", "DEF", 8.2),
  ].map((p, i) => ({ ...p, adp: i + 1, vor: 200 - i * 10 })) as Player[];
  const turns = [1, 5, 9, 13, 16];
  const him = (name: string) => board.find((p) => p.name === name)!;

  /**
   * The old way assumed the best man left at every empty seat and then
   * measured him against a roster he was already on, so he read nought
   * and the second best at his position beat him.
   */
  it("does not read nought for the man the projection assumed", () => {
    const assumed = projectedRoster([], SLOTS, board, turns);
    const worth = takeNowFor([], SLOTS, board, turns, anOpponent(DRAWN), DRAWN);

    expect(assumed).toContain(him("elite"));
    expect(worth(him("elite")).added).toBeGreaterThan(0);
    expect(worth(him("elite")).added).toBeGreaterThan(worth(him("good")).added);
    expect(worth(him("qb1")).added).toBeGreaterThan(worth(him("qb2")).added);
  });

  it("pays nothing now for a man a later turn would get anyway", () => {
    const assumed = projectedRoster([], SLOTS, board, turns.slice(1));
    const worth = takeNowFor([], SLOTS, board, turns, anOpponent(DRAWN), DRAWN);

    expect(assumed).toContain(him("d1"));
    expect(worth(him("d1")).added).toBe(0);
  });

  /**
   * With a quarterback on the roster a second one covers only the weeks
   * the first sits, so he is worth far less than the first was.
   */
  it("pays a second quarterback less than the first", () => {
    const first = takeNowFor([], SLOTS, board, turns, anOpponent(DRAWN), DRAWN);
    const second = takeNowFor(
      [him("qb1")], SLOTS, board.filter((p) => p.name !== "qb1"),
      turns.slice(1), anOpponent(DRAWN), DRAWN,
    );

    expect(second(him("qb2")).added).toBeLessThan(first(him("qb1")).added / 2);
  });

  it("agrees with drawing the whole roster again with him on it", () => {
    const opponent = anOpponent(DRAWN);
    const worth = takeNowFor([], SLOTS, board, turns, opponent, DRAWN);
    const passed = winChance(
      baselineFor(projectedRoster([], SLOTS, board, turns.slice(1)), SLOTS, DRAWN).total,
      opponent,
    );

    for (const p of board) {
      const roster = projectedRoster([p], SLOTS, board, turns.slice(1));
      const drawn = winChance(baselineFor(roster, SLOTS, DRAWN).total, opponent);

      expect(worth(p).added).toBeCloseTo(drawn - passed, 10);
    }
  });

  it("still agrees once the wire covers the seats nobody filled", () => {
    const opponent = anOpponent(DRAWN);
    const wire = { QB: 16, RB: 8, WR: 8, TE: 6, K: 8.5, DEF: 7 };
    const worth = takeNowFor([], SLOTS, board, turns, opponent, DRAWN, wire);
    const passed = winChance(
      baselineFor(
        projectedRoster([], SLOTS, board, turns.slice(1)), SLOTS, DRAWN, wire,
      ).total,
      opponent,
    );

    for (const p of board) {
      const roster = projectedRoster([p], SLOTS, board, turns.slice(1));
      const drawn = winChance(
        baselineFor(roster, SLOTS, DRAWN, wire).total, opponent,
      );

      expect(worth(p).added).toBeCloseTo(drawn - passed, 10);
    }
  });
});

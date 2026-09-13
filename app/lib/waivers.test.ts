/**
 * The two things a waiver page has to get right: a better player at an
 * open slot is worth more than a worse one, and dropping somebody who
 * starts every week costs more than dropping somebody who never does.
 */

import { describe, expect, it } from "vitest";

import { addsFor, capacityOf, dropsFor, netFor, openSpotsFor } from "./waivers.ts";
import { baselineFor, weeksOf, winChance } from "./winShare.ts";
import type { Player } from "./scoring.ts";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];

const DRAWN = 400;

/** a player who scores about this much a week, with an ordinary spread */
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
const anOpponent = (draws = DRAWN) => {
  const players = [
    aMan("theirQb", "QB", 18), aMan("theirRb1", "RB", 15),
    aMan("theirRb2", "RB", 12), aMan("theirWr1", "WR", 14),
    aMan("theirWr2", "WR", 11), aMan("theirTe", "TE", 9),
    aMan("theirFlex", "WR", 10), aMan("theirK", "K", 9),
  ];
  const weeks = players.map((p) => weeksOf(p, draws));

  return Array.from({ length: draws }, (_, i) =>
    weeks.reduce((sum, its) => sum + its[i]!, 0));
};

const aRoom = () => ({
  opponent: anOpponent(), wire: {}, draws: DRAWN,
});

describe("adding a player off the wire", () => {
  it("pays more for a better one at an open slot", () => {
    const pool = [aMan("goodK", "K", 11), aMan("poorK", "K", 6)];
    const adds = addsFor(aRoster(), pool, SLOTS, aRoom());
    const good = adds.find((a) => a.p.key === "goodK")!;
    const poor = adds.find((a) => a.p.key === "poorK")!;

    expect(good.added).toBeGreaterThan(poor.added);
    expect(adds[0]!.p.key).toBe("goodK");
    expect(good.starts).toBeGreaterThan(0.9);
  });
});

describe("how many players a roster can carry", () => {
  it("counts the bench and leaves out injured reserve and taxi", () => {
    const full = [...SLOTS, "BN", "BN", "BN", "IR", "TAXI"];

    expect(capacityOf(full)).toBe(SLOTS.length + 3);
    expect(openSpotsFor(full, SLOTS.length + 1)).toBe(2);
    expect(openSpotsFor(full, 99)).toBe(0);
    expect(capacityOf(null)).toBe(null);
    expect(openSpotsFor(null, 4)).toBe(null);
  });
});

describe("what a pickup is worth once it is paid for", () => {
  it("costs nobody when there is a spot open", () => {
    const roster = aRoster();
    const room = aRoom();
    const [add] = addsFor(roster, [aMan("goodK", "K", 11)], SLOTS, room);
    const paid = netFor(roster, add!, SLOTS, room, 2);

    expect(paid.drop).toBe(null);
    expect(paid.net).toBe(add!.added);
  });

  it("drops the player who costs least, never the player being added", () => {
    const roster = [...aRoster(), aMan("rb5", "RB", 4)];
    const room = aRoom();
    const [add] = addsFor(roster, [aMan("goodK", "K", 11)], SLOTS, room);
    const paid = netFor(roster, add!, SLOTS, room, 0);

    expect(paid.drop?.key).toBe("rb5");
    expect(paid.net).toBeGreaterThan(0);
    expect(paid.net).toBeLessThanOrEqual(add!.added);
  });
});

describe("dropping a player", () => {
  it("costs more for a starter than for a bench player", () => {
    const roster = [...aRoster(), aMan("rb5", "RB", 4)];
    const drops = dropsFor(roster, SLOTS, aRoom());
    const starter = drops.find((d) => d.p.key === "rb1")!;
    const bench = drops.find((d) => d.p.key === "rb5")!;

    expect(starter.costs).toBeGreaterThan(bench.costs);
    expect(starter.starts).toBeGreaterThan(bench.starts);
  });

  it("says the points he takes, who takes his slot, and both win chances", () => {
    const roster = [...aRoster(), aMan("rb5", "RB", 4)];
    const his = dropsFor(roster, SLOTS, aRoom())
      .find((d) => d.p.key === "rb1")!;

    // he scores 15 and the player behind him on the bench scores 4
    expect(his.takes).toBeGreaterThan(4);
    expect(his.takes).toBeLessThan(15);
    expect(his.heir?.key).toBe("rb5");
    expect(his.before - his.after).toBeCloseTo(his.costs, 10);
    expect(his.before).toBeGreaterThan(his.after);
  });

  it("names the slot each player spends most of his starts in", () => {
    const roster = [...aRoster(), aMan("aK", "K", 9)];
    const drops = dropsFor(roster, SLOTS, aRoom());
    const slotOf = (key: string) =>
      drops.find((d) => d.p.key === key)!.slot;

    expect(slotOf("rb1")).toBe("RB");
    expect(slotOf("aK")).toBe("K");
    // three receivers and two receiver slots, so the cheapest plays the flex
    expect(slotOf("flex")).toBe("FLEX");
  });

  /**
   * Every player used to be priced by drawing the season again without
   * him. Now his slot is handed down from the lineup that is already
   * filled, and the two have to agree on every player, flex and all.
   */
  it("agrees with filling the season again without him", () => {
    const roster = [
      ...aRoster(), aMan("wr3", "WR", 10.5), aMan("rb3", "RB", 9),
      aMan("rb5", "RB", 4), aMan("te2", "TE", 7), aMan("aK", "K", 9),
      aMan("aDef", "DEF", 8, 14),
    ];
    const room = { ...aRoom(), wire: { RB: 5, WR: 5, TE: 3, K: 4 } };
    const held = baselineFor(roster, SLOTS, DRAWN, room.wire);
    const with_ = winChance(held.total, room.opponent);

    for (const his of dropsFor(roster, SLOTS, room)) {
      const rest = roster.filter((p) => p.key !== his.p.key);
      const again = baselineFor(rest, SLOTS, DRAWN, room.wire);
      const after = winChance(again.total, room.opponent);
      let heir: Player | null = null;
      let most = 0;

      for (const q of rest) {
        const gained = (again.started[q.key] ?? 0) - (held.started[q.key] ?? 0);

        if (gained > most) {
          most = gained;
          heir = q;
        }
      }

      expect(his.after).toBeCloseTo(after, 10);
      expect(his.costs).toBeCloseTo(with_ - after, 10);
      expect(his.heir?.key ?? null).toBe(heir?.key ?? null);
    }
  });

  /**
   * The cost is a weekly margin against the typical side, so moving the
   * mean of that margin by the points he takes has to move the win chance
   * by about what the normal curve says. Ten points of win chance reads
   * low to anybody who takes it for a season figure, and this is what
   * says the figure is the weekly one it claims to be.
   */
  it("moves the win chance by about what the margin's spread says", () => {
    const roster = [...aRoster(), aMan("rb5", "RB", 4)];
    const room = aRoom();
    const his = dropsFor(roster, SLOTS, room).find((d) => d.p.key === "rb1")!;
    const held = baselineFor(roster, SLOTS, DRAWN, room.wire);
    const margin = held.total.map((x, i) => x - room.opponent[i]!);
    const mean = margin.reduce((s, x) => s + x, 0) / margin.length;
    const sd = Math.sqrt(
      margin.reduce((s, x) => s + (x - mean) ** 2, 0) / margin.length);
    const phi = (z: number) =>
      0.5 * (1 + Math.sign(z) *
        Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI)));
    const said = phi(mean / sd) - phi((mean - his.takes) / sd);

    expect(his.costs).toBeGreaterThan(said - 0.03);
    expect(his.costs).toBeLessThan(said + 0.03);
  });
});

describe("what an add row says beyond the number", () => {
  it("names the player he pushes out and the points he brings", () => {
    const roster = aRoster();
    const [add] = addsFor(roster, [aMan("bigWr", "WR", 20)], SLOTS, aRoom());

    // the cheapest receiver in the lineup is the 10 ppg flex
    expect(add!.displaced?.key).toBe("flex");
    expect(add!.brings).toBeGreaterThan(0);
    expect(add!.after - add!.before).toBeCloseTo(add!.added, 10);
  });

  it("has nobody to push out at a slot the roster cannot fill", () => {
    const [add] = addsFor(aRoster(), [aMan("aK", "K", 9)], SLOTS, aRoom());

    expect(add!.displaced).toBe(null);
    expect(add!.starts).toBeGreaterThan(0.9);
  });
});

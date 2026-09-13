/**
 * The pricing that the waiver page sends to a worker has to come back
 * saying what calling it here would have said.
 */

import { describe, expect, it } from "vitest";

import { roomFor } from "./draftShare.ts";
import type { Player } from "./scoring.ts";
import { addsFor, dropsFor, netsFor } from "./waivers.ts";
import { pricerHere, type SeasonAsk } from "./waiversSeason.ts";
import { weeksOf } from "./winShare.ts";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN"];

const DRAWN = 400;

const aMan = (
  name: string, position: string, ppg: number,
): Player => ({
  name, key: name, position, games: 17, ppg,
  game: {
    ev: ppg, mid: ppg, q1: ppg * 0.7, q3: ppg * 1.3,
    low: ppg * 0.4, high: ppg * 1.7,
  },
}) as Player;

const mine = [
  aMan("qb", "QB", 18), aMan("rb1", "RB", 15), aMan("rb2", "RB", 12),
  aMan("wr1", "WR", 14), aMan("wr2", "WR", 11), aMan("te", "TE", 9),
  aMan("flex", "WR", 10), aMan("aK", "K", 8), aMan("aDef", "DEF", 7),
  aMan("rb3", "RB", 6),
];

const wire = [
  aMan("bigWr", "WR", 16), aMan("goodK", "K", 11), aMan("poorRb", "RB", 3),
];

const players = [...mine, ...wire];

const anAsk = (): SeasonAsk => ({
  ask: "season",
  players,
  schedule: null,
  slots: SLOTS,
  teams: 12,
  draws: DRAWN,
  rosters: null,
  mine: mine.map((p) => p.key),
  pool: wire.map((p) => p.key),
});

describe("the season pricing a worker answers", () => {
  it("says what calling the pricing here would have said", async () => {
    // the room draws a typical week, so warm the cache the same way both do
    weeksOf(players[0]!, DRAWN);

    const room = roomFor(players, SLOTS, 12, DRAWN, null);
    const adds = addsFor(mine, wire, SLOTS, room);
    const drops = dropsFor(mine, SLOTS, room);
    const pricer = pricerHere();
    const said = await pricer.season(anAsk());

    expect(said.adds.map((row) => row.p.key)).toEqual(
      adds.map((row) => row.p.key));
    expect(said.adds.map((row) => row.added)).toEqual(
      adds.map((row) => row.added));
    expect(said.drops.map((row) => row.costs)).toEqual(
      drops.map((row) => row.costs));

    const keys = said.adds.slice(0, 2).map((row) => row.p.key);
    const answered = await pricer.nets({ ask: "nets", keys, openSpots: 0 });
    const here = netsFor(mine, adds.slice(0, 2), SLOTS, room, 0);

    for (const [key, net] of answered.nets) {
      expect(net.net).toBe(here.get(key)!.net);
      expect(net.drop?.key).toBe(here.get(key)!.drop?.key);
    }

    expect(answered.nets.length).toBe(2);
  });

  it("says nothing about nets before the season has been asked for", async () => {
    const answered = await pricerHere()
      .nets({ ask: "nets", keys: ["bigWr"], openSpots: 0 });

    expect(answered.nets).toEqual([]);
  });
});

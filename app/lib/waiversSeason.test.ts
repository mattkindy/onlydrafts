/**
 * The pricing that the waiver page sends to a worker has to come back
 * saying what calling it here would have said.
 */

import { describe, expect, it } from "vitest";

import { WEEKS_OUT } from "./availability.ts";
import { roomFor } from "./draftShare.ts";
import type { Player } from "./scoring.ts";
import { addsFor, dropsFor, netsFor } from "./waivers.ts";
import {
  forTheWeeksLeft, pricerHere, statusesOn, type SeasonAsk,
} from "./waiversSeason.ts";
import { weekOfDraw, weeksOf } from "./winShare.ts";

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

/**
 * Dillon Gabriel had been on reserve three weeks and the waiver page drew
 * him every week of the season at his August availability, the weeks
 * already played included.
 */
describe("the season a waiver page prices", () => {
  const FROM = 4;
  const aWeek = (i: number) => weekOfDraw(i, FROM);

  it("draws no week already played", () => {
    const weeks = new Set(Array.from({ length: DRAWN }, (_, i) => aWeek(i)));

    expect(Math.min(...weeks)).toBe(FROM);
    expect(Math.max(...weeks)).toBe(18);
    expect(weeks.size).toBe(18 - FROM + 1);
  });

  it("never draws a bye already gone", () => {
    const [him] = forTheWeeksLeft([{ ...aMan("early", "WR", 14), bye: 2 }], FROM);
    const drawn = weeksOf(him!, DRAWN);
    const fromTheStart = weeksOf({ ...aMan("early", "WR", 14), bye: 2 }, DRAWN);

    expect(drawn.filter((w) => w === 0).length)
      .toBeLessThan(fromTheStart.filter((w) => w === 0).length);
  });

  it("gives a man on reserve nothing for the weeks the list costs him", () => {
    const [him] = forTheWeeksLeft(
      [{ ...aMan("parked", "QB", 12.1), bye: 12 }], FROM, { parked: "IR" });
    const drawn = weeksOf(him!, DRAWN);
    const parked = drawn.filter((_, i) => aWeek(i) < FROM + WEEKS_OUT);
    const back = drawn.filter((_, i) => aWeek(i) >= FROM + WEEKS_OUT);

    expect(parked.length).toBeGreaterThan(0);
    expect(parked.every((w) => w === 0)).toBe(true);
    expect(back.some((w) => w > 0)).toBe(true);
  });

  it("gives a man ruled out of the coming week nothing for it alone", () => {
    const [him] = forTheWeeksLeft(
      [{ ...aMan("hamstring", "WR", 14), bye: 12 }], FROM, { hamstring: "Out" });
    const drawn = weeksOf(him!, DRAWN);

    expect(drawn.filter((_, i) => aWeek(i) === FROM).every((w) => w === 0))
      .toBe(true);
    expect(drawn.filter((_, i) => aWeek(i) === FROM + 1).some((w) => w > 0))
      .toBe(true);
  });

  it("prices an add on reserve below the same add healthy", async () => {
    const asked = (hurt: Record<string, string>) => pricerHere().season({
      ...anAsk(), from: FROM, hurt,
    });
    const healthy = await asked({});
    const parked = await asked({ bigWr: "IR" });
    const added = (said: typeof healthy) =>
      said.adds.find((row) => row.p.key === "bigWr")!.added;

    expect(added(parked)).toBeLessThan(added(healthy));
  });

  it("takes the injury report's word only for the player it is about", () => {
    const said = statusesOn(
      [aMan("parked", "QB", 12), aMan("sameName", "WR", 9)],
      new Map([
        ["parked", { name: "parked", status: "IR", position: "QB" }],
        ["sameName", { name: "sameName", status: "Out", position: "LB" }],
      ]),
    );

    expect(said).toEqual({ parked: "IR" });
  });
});

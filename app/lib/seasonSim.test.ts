import { describe, expect, it } from "vitest";

import type { Listed } from "./availability.ts";
import type { RosterPlayer } from "./providers.ts";
import type { Player } from "./scoring.ts";
import { chanceIn, splitAtPlayoffs, weeklyStrengths, WIRE_RANK } from "./seasonSim.ts";

const player = (over: Partial<Player>): Player =>
  ({ name: "x", key: "x", position: "RB", ppg: 10, ...over }) as Player;
const on = (key: string): RosterPlayer => ({ key, name: key, pos: "RB" });

describe("a player's chance of playing a week", () => {
  it("reads the injury report for the coming week", () => {
    const p = player({ weeksLeft: { from: 10, plays: [0.8, 0.8] } });

    expect(chanceIn(p, 0, undefined)).toBe(1);
    expect(chanceIn(p, 0, "Out")).toBe(0);
    expect(chanceIn(p, 0, "Questionable")).toBeCloseTo(0.64);
    // a bye in the coming week is a bye whatever the report says
    expect(chanceIn(player({ weeksLeft: { from: 10, plays: [0, 0.8] } }), 0, undefined)).toBe(0);
  });

  it("reads his weeks left after it, a return from reserve and all", () => {
    const p = player({ weeksLeft: { from: 10, plays: [0, 0, 0.5, 0.9] } });

    expect(chanceIn(p, 2, "IR")).toBe(0.5);
    expect(chanceIn(p, 3, "IR")).toBe(0.9);
    // with no weeks to go by, a list that keeps him out for weeks does
    expect(chanceIn(player({}), 3, "IR")).toBe(0);
    expect(chanceIn(player({}), 3, undefined)).toBe(1);
  });
});

describe("each team's strength week by week", () => {
  // one running back a side, so a team's week is its one man's
  const slots = ["RB"];
  const byKey = new Map<string, Player>([
    ["star", player({ key: "star", ppg: 20, weeksLeft: { from: 12, plays: [0, 0, 0, 1, 1, 1] } })],
    ["fill", player({ key: "fill", ppg: 8, weeksLeft: { from: 12, plays: [1, 1, 1, 1, 1, 1] } })],
    ["mid", player({ key: "mid", ppg: 12, weeksLeft: { from: 12, plays: [1, 0, 1, 1, 1, 1] } })],
  ]);
  const listed = new Map<string, Listed>([["star", { name: "star", status: "IR" }]]);
  const rosters = [
    { owner: "ann", keys: [on("star"), on("fill")] },
    { owner: "bo", keys: [on("mid")] },
  ];
  const weekly = weeklyStrengths({ rosters, slots, byKey, listed, season: [], weeks: 6 });
  const mean = (w: number, owner: string) => weekly[w]!.get(owner)!.mean;

  it("starts a man back from reserve in the weeks he is back", () => {
    expect(mean(0, "ann")).toBeCloseTo(8);
    expect(mean(3, "ann")).toBeCloseTo(20);
  });

  it("costs a team the week its starter is on bye", () => {
    expect(mean(1, "bo")).toBe(0);
    expect(mean(2, "bo")).toBeCloseTo(12);
  });

  it("splits where the regular season ends", () => {
    const { byWeek, bracket } = splitAtPlayoffs(weekly, 12, 14, 3);

    expect(byWeek).toHaveLength(3);
    expect(bracket).toHaveLength(3);
    expect(bracket[0]!.get("ann")!.mean).toBeCloseTo(20);
  });
});

describe("a slot the roster cannot fill", () => {
  const slots = ["RB"];
  // four backs nobody has, the third best of them at 6
  const free = [9, 7, 6, 3].map((ppg, i) => player({ key: `fa${i}`, ppg }));
  const byKey = new Map<string, Player>([
    ["mid", player({ key: "mid", ppg: 12, weeksLeft: { from: 12, plays: [1, 0] } })],
    ...free.map((p) => [p.key, p] as [string, Player]),
  ]);
  const weekly = weeklyStrengths({
    rosters: [{ owner: "bo", keys: [on("mid")] }], slots, byKey, listed: new Map(), season: [], weeks: 2,
  });

  it("takes a free agent off the wire rather than nothing", () => {
    expect(WIRE_RANK).toBe(3);
    expect(weekly[1]!.get("bo")!.mean).toBeCloseTo(6);
  });

  it("still starts his own man when he beats the wire", () => {
    expect(weekly[0]!.get("bo")!.mean).toBeCloseTo(12);
  });
});

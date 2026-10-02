/**
 * A waiver add's reason has to match what the drawn weeks did with him,
 * and it can only mention players on your own roster.
 */

import { describe, expect, it } from "vitest";

import { addsFor } from "./waivers.ts";
import { whyWords } from "./waiverWhy.ts";
import { forTheWeeksLeft } from "./waiversSeason.ts";
import { weeksOf } from "./winShare.ts";
import type { Player } from "./scoring.ts";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];

const DRAWN = 720;

/** a player who scores about this much a week and plays every game */
const aMan = (
  name: string, position: string, ppg: number, bye: number | null = null,
): Player => ({
  name, key: name, position, games: 17, ppg, bye,
  game: {
    ev: ppg, mid: ppg, q1: ppg * 0.7, q3: ppg * 1.3,
    low: ppg * 0.4, high: ppg * 1.7,
  },
}) as Player;

/** a roster with every bye in a different week, or with no byes at all */
const aRoster = (byes = true) => [
  aMan("Allen", "QB", 18, byes ? 6 : null),
  aMan("Gibbs", "RB", 15, byes ? 8 : null),
  aMan("Brown", "RB", 12, byes ? 9 : null),
  aMan("Nacua", "WR", 14, byes ? 7 : null),
  aMan("Chase", "WR", 11, byes ? 10 : null),
  aMan("Kelce", "TE", 9, byes ? 11 : null),
  aMan("Pittman", "WR", 10, byes ? 12 : null),
];

const aRoom = () => {
  const theirs = [
    aMan("Q", "QB", 18), aMan("R1", "RB", 15), aMan("R2", "RB", 12),
    aMan("W1", "WR", 14), aMan("W2", "WR", 11), aMan("T", "TE", 9),
    aMan("F", "WR", 10),
  ].map((p) => weeksOf(p, DRAWN));

  return {
    opponent: Array.from({ length: DRAWN }, (_, i) =>
      theirs.reduce((sum, its) => sum + its[i]!, 0)),
    wire: {},
    draws: DRAWN,
  };
};

describe("why a waiver add is worth it", () => {
  it("names the bye week he covers and the starter who is off", () => {
    const [add] = addsFor(aRoster(), [aMan("Spare", "WR", 9.5, 14)], SLOTS, aRoom());
    const said = whyWords(add!.why);
    const byes = add!.why?.parts[0]?.byes ?? [];

    expect(add!.why?.parts[0]?.kind).toBe("bye");
    expect(byes.find((b) => b.week === 7)?.name).toBe("Nacua");
    expect(byes.find((b) => b.week === 7)?.share).toBeGreaterThan(0.9);
    expect(said).toMatch(/in week 7, when Nacua is on bye|in week 7 for Nacua/);
    // a receiver is no use in the weeks a back or the quarterback is off
    expect(byes.map((b) => b.week)).not.toContain(6);
  });

  it("says when he is a drop, once the bye weeks he covers are over", () => {
    const roster = aRoster(false).map((p) =>
      p.name === "Nacua" ? { ...p, bye: 7 } : p);
    const [add] = addsFor(roster, [aMan("Spare", "WR", 9.5, 14)], SLOTS, aRoom());

    expect(whyWords(add!.why)).toMatch(
      /^Starts \d+% of the time in week 7, when Nacua is on bye\. You can drop him after week 7\.$/);
  });

  it("is no help in a bye week that is his own too", () => {
    const [add] = addsFor(aRoster(), [aMan("Spare", "WR", 9.5, 7)], SLOTS, aRoom());

    expect(whyWords(add!.why)).not.toContain("week 7");
  });

  it("says he outscores the starter he beats every week", () => {
    const [add] = addsFor(
      aRoster(false), [aMan("Better", "WR", 13)], SLOTS, aRoom());
    const over = add!.why?.parts[0];

    expect(over?.kind).toBe("over");
    expect(over?.name).toBe("Pittman");
    expect(whyWords(add!.why)).toMatch(
      /^Starts over Pittman and outscores him in \d+ weeks of 10\./);
  });

  it("names the starter the injury report has out", () => {
    const roster = forTheWeeksLeft(aRoster(false), 5, { Gibbs: "IR" });
    const pool = forTheWeeksLeft([aMan("Backup", "RB", 8, 14)], 5);
    const [add] = addsFor(roster, pool, SLOTS, aRoom(), { Gibbs: "IR" });

    expect(add!.why?.parts[0]?.kind).toBe("hurt");
    expect(whyWords(add!.why)).toContain(
      "Fills in for Gibbs, who is on injured reserve.");
  });

  it("only ever mentions players on your roster", () => {
    const roster = aRoster();
    const ours = new Set(roster.map((p) => p.name));
    const pool = [
      aMan("Better", "WR", 13, 14), aMan("Spare", "WR", 9.5, 14),
      aMan("Back", "RB", 11, 5), aMan("Kicker", "K", 8, 9),
      aMan("Tight", "TE", 10, 7), aMan("Passer", "QB", 17, 9),
    ];
    const adds = addsFor(roster, pool, SLOTS, aRoom());

    for (const add of adds) {
      for (const part of add.why?.parts ?? []) {
        if (part.name !== null) {
          expect(ours).toContain(part.name);
        }

        for (const bye of part.byes) {
          expect(ours).toContain(bye.name);
        }
      }

      const said = whyWords(add.why);

      for (const p of pool) {
        expect(said).not.toContain(p.name);
      }
    }
  });
});

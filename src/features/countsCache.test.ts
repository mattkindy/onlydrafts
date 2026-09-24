import { describe, expect, it } from "vitest";
import { asKept } from "./countsCache.js";
import {
  countPlays, FACTOR_DEFAULTS, fitPlayFactors, storePlays,
  type CountedPlays, type PlayRow,
} from "./fitPlayFactors.js";
import type { Call, PlayState } from "../model/playFactors.js";
import { seededRng } from "../sim/rng.js";

const PLAYERS = ["Back", "Wideout", "Slot", "End"];

/**
 * A small league of seeded plays with every field a count reads, and gains
 * that are not whole yards, so a sum that came back in another order would
 * show in the last digit.
 */
const league = (): PlayRow[] => {
  const uniform = seededRng(41);
  const pick = <T>(from: T[]) => from[Math.floor(uniform() * from.length)]!;

  return Array.from({ length: 3000 }, (_, i) => {
    const offence = pick(["NE", "NYJ", "MIA"]);
    const call: Call = uniform() < 0.45 ? "run" : "pass";
    const player = pick(["", ...PLAYERS]);
    const thrownTo = call === "pass" && player !== "";

    return {
      season: 2022 + (i % 3),
      offence, defence: offence === "NE" ? "MIA" : "NE",
      down: 1 + Math.floor(uniform() * 4),
      toGo: 1 + Math.floor(uniform() * 15),
      yardline: 1 + Math.floor(uniform() * 99),
      margin: Math.floor(uniform() * 41) - 20,
      secondsLeft: Math.floor(uniform() * 3600),
      call, shotgun: uniform() < 0.6,
      yards: Math.round((uniform() * 30 - 5) * 100) / 100,
      touchdown: uniform() < 0.05 ? 1 : 0,
      player,
      passer: thrownTo ? pick(["QB1", "QB2"]) : undefined,
      airYards: thrownTo ? Math.floor(uniform() * 40) - 5 : undefined,
      caught: call === "pass" ? uniform() < 0.65 : undefined,
    };
  });
};

const states = (): PlayState[] => {
  const uniform = seededRng(43);

  return Array.from({ length: 30 }, () => ({
    down: 1 + Math.floor(uniform() * 4),
    toGo: 1 + Math.floor(uniform() * 15),
    yardline: 1 + Math.floor(uniform() * 99),
    margin: Math.floor(uniform() * 41) - 20,
    secondsLeft: Math.floor(uniform() * 3600),
  }));
};

describe("the counts kept on the disk", () => {
  it("play every question the same as the counts they were kept from",
    () => {
      const rows = league();
      const counted = countPlays(rows);
      const fit = (from: CountedPlays) =>
        fitPlayFactors([], FACTOR_DEFAULTS, {
          counted: from,
          plays: storePlays(rows),
          split: new Map(PLAYERS.map((player, i): [
            string, { carries: number; targets: number },
          ] => [player, { carries: 0.1 + i * 0.05, targets: 0.3 - i * 0.05 }])),
          positions: new Map([
            ["Back", "RB"], ["Wideout", "WR"], ["Slot", "WR"], ["End", "TE"],
          ]),
        });
      const fresh = fit(counted);
      const kept = fit(asKept(counted));
      const sides = { offence: "NE", defence: "MIA", passer: "QB1" };
      let asked = 0;

      for (const state of states()) {
        expect(kept.runs(state, "NE")).toBe(fresh.runs(state, "NE"));

        for (const call of ["run", "pass"] as const) {
          expect([...kept.goesTo(state, call, PLAYERS)])
            .toEqual([...fresh.goesTo(state, call, PLAYERS)]);
          expect(kept.scores(state, call, 2)).toBe(fresh.scores(state, call, 2));

          for (const player of PLAYERS) {
            for (let seed = 1; seed <= 3; seed++) {
              expect(kept.gains(state, call, player, seededRng(seed), sides))
                .toBe(fresh.gains(state, call, player, seededRng(seed), sides));
              expect(kept.hisOwnPlay?.(
                state, call, player, seededRng(seed), "QB1", sides,
              )).toEqual(fresh.hisOwnPlay?.(
                state, call, player, seededRng(seed), "QB1", sides,
              ));
              asked++;
            }
          }

          expect(kept.atTheGoal?.(state, call, 3, seededRng(5)))
            .toBe(fresh.atTheGoal?.(state, call, 3, seededRng(5)));
        }
      }

      expect(asked).toBeGreaterThan(500);
    });
});

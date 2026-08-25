import { describe, expect, it } from "vitest";
import { walkSeason, type Fixture } from "./walkedSeason.js";
import { noParts, weeklyShare, addParts, scaleParts } from "./boardSource.js";
import { seededRng } from "../sim/rng.js";

/**
 * The walk needs a whole fitted world to run, which a unit test has no
 * business building. These cover the parts that do arithmetic on what
 * it hands back, since those are where a season quietly goes missing.
 */
describe("adding up what a walk produced", () => {
  it("starts a man at nothing in every category", () => {
    const parts = noParts();

    for (const value of Object.values(parts)) {
      expect(value).toBe(0);
    }
  });

  it("adds a game into a running total without dropping a category", () => {
    const into = noParts();
    addParts(into, { carries: 12, rushYds: 54, rushTd: 1 });
    addParts(into, { carries: 8, rushYds: 31 });

    expect(into.carries).toBe(20);
    expect(into.rushYds).toBe(85);
    expect(into.rushTd).toBe(1);
    expect(into.targets).toBe(0);
  });

  it("turns a pile of games into one game", () => {
    const total = noParts();
    addParts(total, { carries: 40, rushYds: 200 });
    const one = scaleParts(total, 1 / 4);

    expect(one.carries).toBe(10);
    expect(one.rushYds).toBe(50);
  });

  it("says a week against his own average, and calls it home or away", () => {
    const parts = (rushYds: number) => ({ ...noParts(), rushYds });
    const share = weeklyShare(
      {
        perGame: parts(100),
        games: 17,
        byWeek: [
          { week: 1, opponent: "GB", home: true, parts: parts(120) },
          { week: 2, opponent: "CHI", home: false, parts: parts(80) },
        ],
      },
      (p) => p.rushYds,
    );

    expect(share[0]).toEqual({ w: 1, opp: "v GB", of: 1.2 });
    expect(share[1]).toEqual({ w: 2, opp: "@ CHI", of: 0.8 });
  });

  it("gives a man with no scoring a flat season rather than a divide by nothing", () => {
    const share = weeklyShare(
      {
        perGame: noParts(), games: 17,
        byWeek: [{ week: 1, opponent: "GB", home: true, parts: noParts() }],
      },
      (p) => p.rushYds,
    );

    expect(share[0]!.of).toBe(1);
  });

  it("plays nothing when it has no fixtures to play", () => {
    const world = { sideFor: () => undefined } as never;
    const out = walkSeason(
      world, [] as Fixture[],
      { runs: 3, gamesFor: () => 17 },
      seededRng(1),
    );

    expect(out.size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { linesFrom, type PlayedGame, type Side } from "./gameFromDrives.js";
import type { FactorDrive } from "./driveFromFactors.js";
import type { PlayFactors, PlayState } from "./playFactors.js";

const state: PlayState = {
  down: 1, toGo: 10, yardline: 50, margin: 0, secondsLeft: 1800,
};

const factors = {} as PlayFactors;

const drive = (over: Partial<FactorDrive>): FactorDrive => ({
  plays: [], ending: "punt", handsOverAt: 60, took: 120, facedAt: [],
  thrownAway: false, ...over,
});

const sides: [Side, Side] = [
  { team: "A", among: ["back", "wideout"], factors, passer: "thrower" },
  { team: "B", among: ["other"], factors },
];

describe("linesFrom", () => {
  it("credits a catch to the man and his passer at once", () => {
    const game: PlayedGame = {
      points: { A: 7, B: 0 }, drives: { A: 1, B: 0 },
      possessions: [{
        team: "A", margin: 0, startedAt: 75,
        drive: drive({
          ending: "touchdown",
          plays: [
            { state, call: "run", player: "back", yards: 8, scored: false, caught: true },
            { state, call: "pass", player: "wideout", yards: 42, scored: true, caught: true },
          ],
        }),
      }],
    };
    const lines = linesFrom(game, sides);

    expect(lines.get("back")?.rushYds).toBe(8);
    expect(lines.get("wideout")?.receptions).toBe(1);
    expect(lines.get("wideout")?.recYds).toBe(42);
    expect(lines.get("wideout")?.recTd).toBe(1);
    expect(lines.get("thrower")?.passYds).toBe(42);
    expect(lines.get("thrower")?.passTd).toBe(1);
  });

  it("gives nobody anything for a throw that was not caught", () => {
    const game: PlayedGame = {
      points: { A: 0, B: 0 }, drives: { A: 1, B: 0 },
      possessions: [{
        team: "A", margin: 0, startedAt: 75,
        drive: drive({
          plays: [{
            state, call: "pass", player: "wideout", yards: 0,
            scored: false, caught: false,
          }],
        }),
      }],
    };
    const lines = linesFrom(game, sides);

    expect(lines.get("wideout")?.receptions ?? 0).toBe(0);
    expect(lines.get("thrower")?.passYds ?? 0).toBe(0);
  });

  it("hangs an interception on the man who threw it", () => {
    const game: PlayedGame = {
      points: { A: 0, B: 0 }, drives: { A: 1, B: 0 },
      possessions: [{
        team: "A", margin: 0, startedAt: 75,
        drive: drive({ ending: "turnover", thrownAway: true }),
      }],
    };

    expect(linesFrom(game, sides).get("thrower")?.interceptions).toBe(1);
  });

  it("leaves a run-away turnover off the passer", () => {
    const game: PlayedGame = {
      points: { A: 0, B: 0 }, drives: { A: 1, B: 0 },
      possessions: [{
        team: "A", margin: 0, startedAt: 75,
        drive: drive({ ending: "turnover", thrownAway: false }),
      }],
    };

    expect(linesFrom(game, sides).get("thrower")?.interceptions ?? 0).toBe(0);
  });
});

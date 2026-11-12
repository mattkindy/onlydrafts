import { describe, expect, it } from "vitest";
import { aheadFields } from "./aheadBoard.js";
import type { Person } from "./aheadRows.js";

const people = new Map<string, Person>([
  ["love", {
    name: "Jeremiyah Love", position: "RB", birthDate: "2005-05-31", entry: 2026,
    drafted: { season: 2026, round: 1, overall: 3 },
  }],
  ["walkon", { name: "A Walk On", position: "WR", birthDate: "1999-01-15", drafted: null }],
]);
const said = new Map([
  ["love", [
    { ppg: 13.9, games: 13.0 }, { ppg: 13.8, games: 13.5 }, { ppg: 12.2, games: 13.7 },
  ]],
  ["walkon", [
    { ppg: 4, games: 6 }, { ppg: 3.5, games: 3 }, { ppg: 3, games: 1 },
  ]],
]);

describe("aheadFields", () => {
  it("writes the shape the app reads", () => {
    const fields = aheadFields(
      { playerId: "love", position: "RB", ppg: 11.1 }, 2026, { said, people });

    expect(fields).toEqual({
      ahead: [
        { of: 1.252, games: 13 },
        { of: 1.243, games: 13.5 },
        { of: 1.099, games: 13.7 },
      ],
      age: 21.3,
      drafted: { season: 2026, round: 1, overall: 3 },
    });
    expect(fields.ahead).toHaveLength(3);
  });

  it("says null for a player nobody drafted", () => {
    expect(aheadFields(
      { playerId: "walkon", position: "WR", ppg: 5 }, 2026, { said, people }).drafted)
      .toBeNull();
  });

  it("leaves out the seasons where the board's rate is too small to divide", () => {
    const fields = aheadFields(
      { playerId: "walkon", position: "WR", ppg: 0.4 }, 2026, { said, people });

    expect(fields.ahead).toBeUndefined();
    expect(fields.age).toBe(27.6);
  });

  it("writes nothing it does not know", () => {
    expect(aheadFields(
      { playerId: "stranger", position: "TE", ppg: 6 }, 2026, { said, people })).toEqual({});
  });

  it("writes nothing on a kicker or a defence", () => {
    expect(aheadFields(
      { playerId: "love", position: "K", ppg: 8 }, 2026, { said, people })).toEqual({});
  });
});

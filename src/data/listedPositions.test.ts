import { describe, expect, it } from "vitest";
import { fantasySpot, isFantasyPosition } from "./listedPositions.js";

describe("fantasySpot", () => {
  it("keeps what the stat rows say when they say a fantasy position", () => {
    expect(fantasySpot("WR", "TE")).toBe("WR");
  });

  it("asks the roster for a player the stat rows file on defence", () => {
    expect(fantasySpot("CB", "WR")).toBe("WR");
  });

  it("has nobody for a player neither source puts on offence", () => {
    expect(fantasySpot("CB", "S")).toBeUndefined();
    expect(fantasySpot("CB", undefined)).toBeUndefined();
  });
});

describe("isFantasyPosition", () => {
  it("covers the four the board projects and nothing else", () => {
    expect(["QB", "RB", "WR", "TE"].every(isFantasyPosition)).toBe(true);
    expect(["FB", "CB", "K", "DEF"].some(isFantasyPosition)).toBe(false);
  });
});

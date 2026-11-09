import { describe, expect, it } from "vitest";

import { landingTab } from "./tabs.ts";

const DRAFTING = ["draft", "matchup", "league", "players", "team"];
const PLAYING = ["matchup", "league", "players", "team", "stats"];

describe("the tab a reload lands on", () => {
  it("stays on stats while the season is still being read", () => {
    expect(landingTab("stats", DRAFTING, false, "leagues")).toBe("stats");
  });

  it("keeps stats once the season turns out to be under way", () => {
    expect(landingTab("stats", PLAYING, true, "leagues")).toBe("stats");
  });

  it("moves off a tab the league does not have, once that is known", () => {
    expect(landingTab("stats", DRAFTING, true, "leagues")).toBe("draft");
    expect(landingTab("draft", PLAYING, true, "leagues")).toBe("matchup");
  });

  it("leaves the league list alone", () => {
    expect(landingTab("leagues", PLAYING, true, "leagues")).toBe("leagues");
  });
});

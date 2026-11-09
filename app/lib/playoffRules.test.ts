import { describe, expect, it } from "vitest";

import { leagueRules, readRules, rulesSay } from "./playoffRules.ts";

const league = {
  provider: "sleeper", leagueId: "1", size: 12, playoffTeams: 6,
  divisions: [{ id: 1, name: "East" }, { id: 2, name: "West" }, { id: 3, name: "North" }],
};

describe("a league's playoff rules", () => {
  it("starts from what the provider says", () => {
    expect(leagueRules(league)).toEqual({
      teams: 6, seedBy: "wins", ties: ["pf"], divisions: true,
    });
    expect(leagueRules({ ...league, divisions: null, medianGame: true, seedTiebreak: "h2h" }))
      .toEqual({ teams: 6, seedBy: "median", ties: ["h2h", "pf"], divisions: false });
  });

  it("keeps what was saved where it still makes sense", () => {
    expect(readRules({ teams: 4, seedBy: "pf", ties: ["h2h", "paMost"], divisions: false }, league))
      .toEqual({ teams: 4, seedBy: "pf", ties: ["h2h", "paMost"], divisions: false });
    // nonsense falls back field by field
    expect(readRules({ teams: 40, seedBy: "luck", ties: ["h2h", "h2h", "vibes"] }, league))
      .toEqual({ teams: 6, seedBy: "wins", ties: ["h2h"], divisions: true });
    // divisions cannot be on in a league without them
    expect(readRules({ divisions: true }, { ...league, divisions: null }).divisions).toBe(false);
    expect(readRules(null, league)).toEqual(leagueRules(league));
  });

  it("says itself in a line", () => {
    expect(rulesSay(leagueRules(league), 3)).toBe("3 division winners + 3 wild cards");
    expect(rulesSay({ teams: 4, seedBy: "allplay", ties: [], divisions: false }, 0))
      .toBe("top 4 make it, by all-play");
  });
});

/**
 * ESPN's scoring read off a league as ESPN actually sent it.
 *
 * The earlier tests were written from a reading of ESPN's stat ids, so
 * they agreed with that reading whether or not it was right, and it was
 * wrong three times: the kicking ids were shifted a band, the plain
 * price was read where ESPN had put the defence's own beside it, and a
 * quarterback's interception was paid as a defence's. The fixture is
 * the scoring block of a league that runs ESPN's standard PPR with a
 * gentler points allowed ladder, so every line here is a number a
 * commissioner could check against the league settings page.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { espnPays, type EspnScoringItem, type League } from "./providers.ts";

const items = JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "fixtures", "espnScoringItems.json"), "utf8",
)) as EspnScoringItem[];

describe("a standard PPR league on ESPN", () => {
  const pays = espnPays(items);

  it("pays passing, rushing and receiving the standard way", () => {
    expect(pays).toMatchObject({
      pass_yd: 0.04, pass_td: 4, pass_int: -2,
      rush_yd: 0.1, rush_td: 6,
      rec: 1, rec_yd: 0.1, rec_td: 6,
      fum_lost: -2, rush_2pt: 2,
    });
  });

  it("pays a kicker by distance, with a point off for a miss", () => {
    expect(pays).toMatchObject({
      xpm: 1,
      fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4,
      fgm_50_59: 5, fgm_60p: 6,
      fgmiss_0_19: -1, fgmiss_20_29: -1, fgmiss_30_39: -1,
      fgmiss_40_49: -1, fgmiss_50_59: -1, fgmiss_60p: -1,
    });
    // this league does not dock a missed extra point
    expect(pays.xpmiss).toBeUndefined();
  });

  it("pays a defence for what it does, not only for scoring", () => {
    expect(pays).toMatchObject({
      sack: 1, int: 2, fum_rec: 2, blk_kick: 2, safe: 2, def_td: 6,
    });
  });

  /**
   * ESPN steps at 14-17 and 18-21 where the board has one step at
   * 14-20, and this league pays the first a point and leaves the second
   * out. A step left out of a priced ladder is nought, so the board's
   * step is the mean of one and nought.
   */
  it("reads the points allowed ladder, blanks included", () => {
    expect(pays).toMatchObject({
      pts_allow_0: 5, pts_allow_1_6: 4, pts_allow_7_13: 3,
      pts_allow_14_20: 0.5, pts_allow_21_27: 0,
      pts_allow_28_34: -1, pts_allow_35p: -4,
    });
  });

  it("does not pay a quarterback for a defence's interception", () => {
    expect(pays.int).toBe(2);
    expect(pays.pass_int).toBe(-2);
  });
});

/** enough of a league for a matchup read, which wants only these fields */
const leagueLike = (over: Partial<League>): League => ({
  provider: "sleeper", leagueId: "9", season: 2025, name: "test", size: 2,
  pays: {}, slots: null, userId: "u1", team: "one", members: {},
  myRoster: [], myPicks: [], draftSlot: null, snake: true, allRosters: [],
  ...over,
});

/** answer whichever url is asked for, and shout about any that is not */
const serve = (routes: Record<string, unknown>) => {
  globalThis.fetch = ((url: string) => {
    const body = Object.entries(routes)
      .find(([part]) => String(url).includes(part))?.[1];

    if (body === undefined) {
      throw new Error("nothing mocked for " + url);
    }

    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
};

const SLEEPER_MEN = {
  "100": { full_name: "Josh Allen", position: "QB", team: "BUF" },
  "200": { full_name: "Bijan Robinson", position: "RB", team: "ATL" },
  "300": { full_name: "Puka Nacua", position: "WR", team: "LA" },
  "400": { full_name: "Jahmyr Gibbs", position: "RB", team: "DET" },
};

describe("this week's matchups on Sleeper", () => {
  beforeEach(() => {
    localStorage.clear();
    serve({
      "/players/nfl": SLEEPER_MEN,
      "/matchups/4": [
        {
          matchup_id: 1, roster_id: 1, points: 88.5,
          starters: ["100", "200"], players: ["100", "200", "300"],
          starters_points: [24.1, 64.4], players_points: {
            "100": 24.1, "200": 64.4, "300": 7.2,
          },
        },
        {
          matchup_id: 1, roster_id: 2, points: 71,
          starters: ["300", "400"], players: ["300", "400"],
          starters_points: [7.2, 63.8], players_points: {
            "300": 7.2, "400": 63.8,
          },
        },
        // a third roster on its own has nobody to play, and Sleeper
        // leaves its matchup id empty for the week
        { matchup_id: null, roster_id: 3, points: 0, starters: [], players: [] },
      ],
      "/rosters": [
        { roster_id: 1, owner_id: "u1", players: ["100", "200", "300"] },
        { roster_id: 2, owner_id: "u2", players: ["300", "400"] },
        { roster_id: 3, owner_id: "u3", players: [] },
      ],
    });
  });

  it("pairs the two sides, names the owners and scores the starters", async () => {
    const { PROVIDERS } = await import("./providers.ts");
    const league = leagueLike({
      slots: ["QB", "RB", "BN"],
      members: { u1: "one", u2: "two", u3: "three" },
    });
    const games = await PROVIDERS["sleeper"]!.matchupsFor!(league, 4);

    expect(games).toHaveLength(1);

    const [home, away] = games[0]!.sides;

    expect([home.owner, away.owner]).toEqual(["one", "two"]);
    expect([home.points, away.points]).toEqual([88.5, 71]);
    expect(home.starters).toEqual([
      { key: "joshallen", slot: "QB", points: 24.1 },
      { key: "bijanrobinson", slot: "RB", points: 64.4 },
    ]);
    expect(home.bench).toEqual([{ key: "pukanacua", points: 7.2 }]);
    expect(away.starters.map((s) => s.key)).toEqual(["pukanacua", "jahmyrgibbs"]);
    expect(away.bench).toEqual([]);
  });
});

describe("this week's matchups on ESPN", () => {
  const entry = (
    id: number, fullName: string, positionId: number,
    lineupSlotId: number, points: number,
  ) => ({
    playerId: id,
    lineupSlotId,
    playerPoolEntry: {
      appliedStatTotal: points,
      player: { id, fullName, defaultPositionId: positionId },
    },
  });

  beforeEach(() => {
    localStorage.clear();
    serve({
      "/players?": [],
      "/leagues/77": {
        teams: [
          { id: 1, location: "Team", nickname: "One" },
          { id: 2, name: "Team Two" },
        ],
        schedule: [
          {
            matchupPeriodId: 4,
            home: {
              teamId: 1, totalPoints: 80, totalPointsLive: 88.5,
              rosterForCurrentScoringPeriod: { entries: [
                entry(3918298, "Josh Allen", 1, 0, 24.1),
                entry(4430807, "Bijan Robinson", 2, 2, 64.4),
                entry(4426515, "Puka Nacua", 3, 20, 7.2),
              ] },
            },
            away: {
              teamId: 2, totalPoints: 71,
              rosterForCurrentScoringPeriod: { entries: [
                entry(4429795, "Jahmyr Gibbs", 2, 2, 63.8),
                entry(4426515, "Puka Nacua", 3, 4, 7.2),
              ] },
            },
          },
          // last week's game comes back in the same schedule
          { matchupPeriodId: 3, home: { teamId: 1 }, away: { teamId: 2 } },
        ],
      },
    });
  });

  it("pairs home with away, names the teams and scores the starters", async () => {
    const { PROVIDERS } = await import("./providers.ts");
    const league = leagueLike({ provider: "espn", leagueId: "77" });
    const games = await PROVIDERS["espn"]!.matchupsFor!(league, 4);

    expect(games).toHaveLength(1);

    const [home, away] = games[0]!.sides;

    expect([home.owner, away.owner]).toEqual(["Team One", "Team Two"]);
    // the live total wins where there is one, and the settled total is
    // used for a side whose games have not started
    expect([home.points, away.points]).toEqual([88.5, 71]);
    expect(home.starters).toEqual([
      { key: "joshallen", slot: "QB", points: 24.1 },
      { key: "bijanrobinson", slot: "RB", points: 64.4 },
    ]);
    expect(home.bench).toEqual([{ key: "pukanacua", points: 7.2 }]);
    expect(away.starters.map((s) => s.slot)).toEqual(["RB", "WR"]);
  });
});

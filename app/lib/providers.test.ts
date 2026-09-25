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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { statsSay, type StatRecord } from "./boxScore.ts";
import {
  espnPays, espnPlayedOf, espnSlotsOf, listedPlayers, playerFileGoodFor,
  sleeperOnBoard, sleeperPlayedOf, sleeperPointsOf,
  type EspnScoringItem, type EspnStatRecord, type League,
} from "./providers.ts";
import { knownSlot, slotTakes, type Pays } from "./scoring.ts";
import { keep } from "./store.ts";

const fixture = <T>(name: string) => JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "fixtures", name), "utf8")) as T;

const items = fixture<EspnScoringItem[]>("espnScoringItems.json");

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
   * out. A step left out of a priced ladder is zero, so the board's
   * step is the mean of one and zero.
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

/**
 * Sleeper's player file, which a session reads once and keeps, so every
 * test in this file shares it and the players any of them need are here.
 */
const SLEEPER_MEN = {
  "100": { full_name: "Josh Allen", position: "QB", team: "BUF" },
  "200": { full_name: "Bijan Robinson", position: "RB", team: "ATL" },
  "300": { full_name: "Puka Nacua", position: "WR", team: "LA" },
  "400": { full_name: "Jahmyr Gibbs", position: "RB", team: "DET" },
  "8112": { full_name: "Drake London", position: "WR", team: "ATL" },
  "650": { full_name: "Nick Folk", position: "K", team: "ATL" },
  "8168": { full_name: "Skyy Moore", position: "WR", team: "GB" },
  // Sleeper gives a defence no name, only its team
  "ATL": { position: "DEF", team: "ATL" },
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

  it("takes the lineup off the roster when the week has none on it", async () => {
    serve({
      "/players/nfl": SLEEPER_MEN,
      "/matchups/4": [
        { matchup_id: 1, roster_id: 1, points: 0, starters: null, players: ["100", "200"] },
        {
          matchup_id: 1, roster_id: 2, points: 0,
          starters: ["300", "400"], players: ["300", "400"],
        },
      ],
      "/rosters": [
        {
          roster_id: 1, owner_id: "u1", players: ["100", "200"],
          starters: ["100", "200"],
        },
        { roster_id: 2, owner_id: "u2", players: ["300", "400"] },
      ],
    });

    const { PROVIDERS } = await import("./providers.ts");
    const league = leagueLike({
      slots: ["QB", "RB"], members: { u1: "one", u2: "two" },
    });
    const games = await PROVIDERS["sleeper"]!.matchupsFor!(league, 4);

    expect(games[0]!.sides[0]!.starters.map((s) => s.name))
      .toEqual(["Josh Allen", "Bijan Robinson"]);
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
    // a league with no scoring kept cannot price the stats feed, so the
    // matchup feed's figures are used as they are
    expect(home.starters).toEqual([
      {
        key: "joshallen", name: "Josh Allen", team: "BUF", slot: "QB",
        points: 24.1, booked: 24.1,
      },
      {
        key: "bijanrobinson", name: "Bijan Robinson", team: "ATL", slot: "RB",
        points: 64.4, booked: 64.4,
      },
    ]);
    expect(home.bench).toEqual([
      { key: "pukanacua", name: "Puka Nacua", points: 7.2, booked: 7.2 },
    ]);
    expect(away.starters.map((s) => s.key)).toEqual(["pukanacua", "jahmyrgibbs"]);
    expect(away.bench).toEqual([]);
  });
});

const stats = fixture<Record<string, StatRecord>>("sleeperStatsWeek3.json");

/** the league that paid Drake London nothing a catch and a tenth a yard */
const pays = fixture<Pays>("sleeperScoringSettings.json");

describe("sleeperPointsOf", () => {
  it("gives a receiver a tenth a yard and nothing a catch, as Sleeper did", () => {
    // 8 catches for 154 yards, which Sleeper's matchups had at 15.4 too
    expect(sleeperPointsOf(stats["8112"]!, pays)).toBe(15.4);
  });

  it("pays a kicker by field goal yardage where the league does", () => {
    // 75 yards of field goals at a tenth, and three extra points
    expect(sleeperPointsOf(stats["650"]!, pays)).toBe(10.5);
  });

  it("pays kick return yards on a receiver", () => {
    // 31 receiving yards and 101 on returns at a hundredth
    expect(sleeperPointsOf(stats["8168"]!, pays)).toBe(4.11);
  });

  it("scores a defence off its points allowed band and what it took", () => {
    // a sack, a blocked kick, a fourth down stop, 7 to 13 allowed, and
    // 68 return yards at a hundredth
    expect(sleeperPointsOf(stats["ATL"]!, pays)).toBe(8.68);
    // Sleeper's own matchups had the Packers at 3.52
    expect(sleeperPointsOf(stats["GB"]!, pays)).toBe(3.52);
  });

  it("scores a two point catch, return yards and a lost fumble together", () => {
    const record: StatRecord = {
      rec: 5, rec_yd: 62, rec_td: 1, rec_2pt: 1,
      kr_yd: 48, pr_yd: 12, fum_lost: 1,
      // what Sleeper puts beside the counts, which no league prices
      pts_std: 99, gp: 1, rec_tgt: 7,
    };

    // 6.2 + 6 + 2 + 0.48 + 0.12 - 2
    expect(sleeperPointsOf(record, pays)).toBe(12.8);
  });

  it("pays a quarterback's two point pass at the league's own rate", () => {
    expect(sleeperPointsOf({ pass_yd: 200, pass_2pt: 1 }, { ...pays, pass_2pt: 1 }))
      .toBe(9);
  });

  it("gives nothing for a category the league has no rate for", () => {
    expect(sleeperPointsOf({ rec: 10 }, { rec_yd: 0.1 })).toBe(0);
  });
});

describe("sleeperPlayedOf", () => {
  it("takes a player's points and his line off the one record", () => {
    const played = sleeperPlayedOf(stats["8112"], "WR", pays);

    expect(played.points).toBe(15.4);
    expect(played.stats).toEqual({
      kind: "player",
      line: expect.objectContaining({ receptions: 8, targets: 9, recYds: 154 }),
    });
    // the line prices to the points beside it in this league
    expect(played.stats?.kind === "player" && played.stats.line.recYds * 0.1)
      .toBeCloseTo(played.points, 6);
  });

  it("gives a player with no record nothing and no line", () => {
    expect(sleeperPlayedOf(undefined, "WR", pays)).toEqual({ points: 0 });
  });
});

describe("this week's cards on Sleeper, off the stats feed", () => {
  /**
   * Sleeper's matchups had London at 10 for a spell while the stats had
   * 154 yards, which is how a card came to say 10 points beside a line
   * worth fifteen. Each test asks for its own week, since a session keeps
   * the week's stats for thirty seconds.
   */
  const matchups = [
    {
      matchup_id: 1, roster_id: 1, points: 29.18,
      starters: ["8112", "650", "ATL"], players: ["8112", "650", "ATL", "8168"],
      starters_points: [10, 10.5, 8.68],
      players_points: { "8112": 10, "650": 10.5, "ATL": 8.68, "8168": 4.11 },
    },
    {
      matchup_id: 1, roster_id: 2, points: 7.2,
      starters: ["300"], players: ["300"],
      starters_points: [7.2], players_points: { "300": 7.2 },
    },
  ];
  const rosters = [
    { roster_id: 1, owner_id: "u1", players: ["8112", "650", "ATL", "8168"] },
    { roster_id: 2, owner_id: "u2", players: ["300"] },
  ];
  const league = leagueLike({
    season: 2026, pays, slots: ["WR", "K", "DEF", "BN"],
    members: { u1: "one", u2: "two" },
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("puts the stats feed's points and line on the same card", async () => {
    serve({
      "/players/nfl": SLEEPER_MEN,
      "/matchups/3": matchups,
      "/rosters": rosters,
      "/stats/nfl/regular/2026/3": stats,
    });

    const { PROVIDERS } = await import("./providers.ts");
    const [game] = await PROVIDERS["sleeper"]!.matchupsFor!(league, 3);
    const [home, away] = game!.sides;
    const london = home.starters[0]!;

    expect(london).toMatchObject({
      key: "drakelondon", slot: "WR", points: 15.4, booked: 10,
    });
    expect(statsSay(london.stats, "WR")).toEqual(["8/9 rec, 154 yds"]);
    expect(home.starters[2]).toMatchObject({ slot: "DEF", points: 8.68 });
    expect(statsSay(home.starters[2]!.stats, "DEF"))
      .toEqual(["13 allowed", "1 sack"]);
    expect(home.bench[0]).toMatchObject({ name: "Skyy Moore", points: 4.11 });
    // the side adds up its own starters, so the card's rows reach its total
    expect(home.points).toBe(34.58);
    expect(home.adjustment).toBe(0);
    // Puka Nacua has no record for the week, since the Rams have not played
    expect(away.starters[0]).toMatchObject({ points: 0, booked: 7.2 });
    expect(away.starters[0]!.stats).toBeUndefined();
  });

  it("keeps a commissioner's correction on top of the starters", async () => {
    serve({
      "/players/nfl": SLEEPER_MEN,
      "/matchups/4": [{ ...matchups[0], points: 31.18 }, matchups[1]],
      "/rosters": rosters,
      "/stats/nfl/regular/2026/4": stats,
    });

    const { PROVIDERS } = await import("./providers.ts");
    const [game] = await PROVIDERS["sleeper"]!.matchupsFor!(league, 4);

    expect(game!.sides[0].adjustment).toBe(2);
    expect(game!.sides[0].points).toBe(36.58);
  });

  it("falls back to the matchup feed with no lines when the stats will not come", async () => {
    serve({
      "/players/nfl": SLEEPER_MEN,
      "/matchups/5": matchups,
      "/rosters": rosters,
    });
    // the stats route is left unserved, which throws the way a failed read does
    const { PROVIDERS } = await import("./providers.ts");
    const [game] = await PROVIDERS["sleeper"]!.matchupsFor!(league, 5);
    const london = game!.sides[0].starters[0]!;

    expect(london.points).toBe(10);
    expect(london.stats).toBeUndefined();
    expect(game!.sides[0].points).toBe(29.18);
  });
});

/** a roster entry as ESPN sent it, trimmed to what a matchup reads */
interface EspnFixtureEntry {
  playerId: number;
  lineupSlotId: number;
  playerPoolEntry: {
    appliedStatTotal: number;
    player: { fullName: string; stats: EspnStatRecord[] };
  };
}

describe("espnPlayedOf", () => {
  const { week2 } = fixture<{ week2: EspnFixtureEntry[] }>(
    "espnRosterEntries.json");

  it("reads a defence's points and line off its record for the week", () => {
    const played = espnPlayedOf(week2[0]!, "DEF", 2);

    expect(played.points).toBe(20);
    expect(played.booked).toBe(20);
    expect(statsSay(played.stats, "DEF"))
      .toEqual(["3 allowed", "4 sacks, 1 INT, 1 FR, 1 TD"]);
  });

  it("reads nothing off a record for another week", () => {
    const played = espnPlayedOf(week2[0]!, "DEF", 3);

    expect(played.stats).toBeUndefined();
    expect(played.points).toBe(20);
  });
});

describe("this week's matchups on ESPN", () => {
  const entry = (
    id: number, fullName: string, positionId: number,
    lineupSlotId: number, points: number, proTeamId?: number,
  ) => ({
    playerId: id,
    lineupSlotId,
    playerPoolEntry: {
      appliedStatTotal: points,
      player: {
        id, fullName, defaultPositionId: positionId,
        ...(proTeamId ? { proTeamId } : {}),
      },
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
                entry(3918298, "Josh Allen", 1, 0, 24.1, 2),
                entry(4430807, "Bijan Robinson", 2, 2, 64.4, 1),
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

  it("asks again without the period when ESPN sends no schedule", async () => {
    const asked: string[] = [];
    const game = {
      matchupPeriodId: 4,
      home: {
        teamId: 1, totalPoints: 0,
        rosterForMatchupPeriod: { entries: [entry(1, "Josh Allen", 1, 0, 0)] },
      },
      away: {
        teamId: 2, totalPoints: 0,
        rosterForMatchupPeriod: { entries: [entry(2, "Bo Nix", 1, 0, 0)] },
      },
    };

    globalThis.fetch = ((url: string) => {
      asked.push(String(url));

      const teams = [{ id: 1, name: "Team One" }, { id: 2, name: "Team Two" }];

      if (String(url).includes("/players?")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }

      // ESPN sends back no schedule at all for a period it has not started
      const body = String(url).includes("scoringPeriodId")
        ? { teams }
        : { teams, schedule: [game] };

      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    }) as unknown as typeof fetch;

    const { PROVIDERS } = await import("./providers.ts");
    const league = leagueLike({ provider: "espn", leagueId: "77" });
    const games = await PROVIDERS["espn"]!.matchupsFor!(league, 4);

    expect(games).toHaveLength(1);
    expect(asked.some((url) => url.includes("scoringPeriodId=4"))).toBe(true);
  });

  it("reads a week ESPN has not made live yet off the matchup period", async () => {
    serve({
      "/players?": [],
      "/leagues/77": {
        teams: [{ id: 1, name: "Team One" }, { id: 2, name: "Team Two" }],
        schedule: [{
          matchupPeriodId: 4,
          home: {
            teamId: 1, totalPoints: 0,
            rosterForMatchupPeriod: { entries: [
              entry(3918298, "Josh Allen", 1, 0, 0, 2),
            ] },
          },
          away: {
            teamId: 2, totalPoints: 0,
            rosterForMatchupPeriod: { entries: [
              entry(4429795, "Jahmyr Gibbs", 2, 2, 0),
            ] },
          },
        }],
      },
    });

    const { PROVIDERS } = await import("./providers.ts");
    const league = leagueLike({ provider: "espn", leagueId: "77" });
    const games = await PROVIDERS["espn"]!.matchupsFor!(league, 4);

    expect(games[0]!.sides[0]!.starters.map((s) => s.name))
      .toEqual(["Josh Allen"]);
    expect(games[0]!.sides[1]!.starters.map((s) => s.name))
      .toEqual(["Jahmyr Gibbs"]);
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
      {
        key: "joshallen", name: "Josh Allen", team: "BUF", slot: "QB",
        points: 24.1, booked: 24.1,
      },
      {
        key: "bijanrobinson", name: "Bijan Robinson", team: "ATL", slot: "RB",
        points: 64.4, booked: 64.4,
      },
    ]);
    expect(home.bench).toEqual([
      { key: "pukanacua", name: "Puka Nacua", points: 7.2, booked: 7.2 },
    ]);
    expect(away.starters.map((s) => s.slot)).toEqual(["RB", "WR"]);
  });

  it("takes points and a line off the same stats record ESPN sends", async () => {
    const entries = fixture<{ week3: EspnFixtureEntry[] }>(
      "espnRosterEntries.json").week3;
    const byName = (name: string) => entries
      .find((e) => e.playerPoolEntry.player.fullName === name)!;

    serve({
      "/players?": [],
      "/leagues/77": {
        teams: [{ id: 1, name: "Team One" }, { id: 2, name: "Team Two" }],
        schedule: [{
          matchupPeriodId: 3,
          home: {
            teamId: 1, totalPoints: 23.4, totalPointsLive: 24.4,
            rosterForCurrentScoringPeriod: { entries: [
              { ...byName("Drake London"), lineupSlotId: 4 },
              { ...byName("Trey Smack"), lineupSlotId: 17 },
            ] },
          },
          away: {
            teamId: 2, totalPoints: 17.96,
            rosterForCurrentScoringPeriod: { entries: [
              { ...byName("Jordan Love"), lineupSlotId: 0 },
              { ...byName("Josh Allen"), lineupSlotId: 7 },
            ] },
          },
        }],
      },
    });

    const { PROVIDERS } = await import("./providers.ts");
    const league = leagueLike({ provider: "espn", leagueId: "77", season: 2026 });
    const [game] = await PROVIDERS["espn"]!.matchupsFor!(league, 3);
    const [home, away] = game!.sides;
    const london = home.starters[0]!;

    // this league pays a point a catch, so 8 catches and 154 yards is 23.4
    expect(london.points).toBe(23.4);
    expect(statsSay(london.stats, "WR")).toEqual(["8/9 rec, 154 yds"]);
    expect(statsSay(home.starters[1]!.stats, "K")).toEqual(["0/1 FG, 2/2 XP"]);
    expect(home.points).toBe(24.4);
    expect(statsSay(away.starters[0]!.stats, "QB"))
      .toEqual(["22/41, 249 yds, 2 TD"]);
    // Josh Allen has only a projection for the week, which is not a line
    expect(away.starters[1]).toMatchObject({ points: 0 });
    expect(away.starters[1]!.stats).toBeUndefined();
  });

  it("reads OP as a superflex and the two narrow flexes by their own names", async () => {
    serve({
      "/players?": [],
      "/leagues/77": {
        teams: [{ id: 1, name: "Team One" }, { id: 2, name: "Team Two" }],
        schedule: [{
          matchupPeriodId: 4,
          home: {
            teamId: 1, totalPoints: 0,
            rosterForCurrentScoringPeriod: { entries: [
              entry(3918298, "Josh Allen", 1, 0, 0, 2),
              entry(4361741, "Bo Nix", 1, 7, 0, 7),
              entry(4430807, "Bijan Robinson", 2, 3, 0, 1),
              entry(4361307, "Trey McBride", 4, 5, 0, 22),
            ] },
          },
          away: { teamId: 2, totalPoints: 0 },
        }],
      },
    });

    const { PROVIDERS } = await import("./providers.ts");
    const league = leagueLike({ provider: "espn", leagueId: "77" });
    const games = await PROVIDERS["espn"]!.matchupsFor!(league, 4);

    expect(games[0]!.sides[0]!.starters.map((s) => s.slot))
      .toEqual(["QB", "SUPER_FLEX", "WRRB_FLEX", "REC_FLEX"]);
  });
});

describe("an ESPN league that will not open", () => {
  beforeEach(() => { localStorage.clear(); });

  /** ESPN's status for the direct read, and the relay's for the second */
  const answering = (direct: number | "offline", relay?: number) => {
    globalThis.fetch = ((url: string) => {
      if (String(url).includes("fantasy.espn.com")) {
        return direct === "offline"
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve({ ok: false, status: direct, json: () => Promise.resolve({}) });
      }

      return Promise.resolve({
        ok: false, status: relay, json: () => Promise.resolve({ error: "ESPN refused" }),
      });
    }) as unknown as typeof fetch;
  };

  const withCookies = () => {
    keep("espnSwid", "{ABC}");
    keep("espnS2", "x".repeat(90));
  };

  it("says there is no such league on a 404, without asking for cookies", async () => {
    answering(404);

    const { PROVIDERS, NeedsEspnCookies } = await import("./providers.ts");
    const read = PROVIDERS["espn"]!.leaguesFor("77", 2031);

    await expect(read).rejects.toThrow("ESPN has no league 77 for season 2031.");
    await expect(read).rejects.not.toBeInstanceOf(NeedsEspnCookies);
  });

  it("says the same on a 400 for an id ESPN cannot read", async () => {
    answering(400);

    const { PROVIDERS } = await import("./providers.ts");

    await expect(PROVIDERS["espn"]!.leaguesFor("abc", 2026))
      .rejects.toThrow("ESPN has no league abc for season 2026.");
  });

  it("asks for cookies when ESPN refuses a private league", async () => {
    answering(401);

    const { PROVIDERS, NeedsEspnCookies } = await import("./providers.ts");

    await expect(PROVIDERS["espn"]!.leaguesFor("77", 2026))
      .rejects.toBeInstanceOf(NeedsEspnCookies);
  });

  it("goes through the relay when the browser cannot read ESPN, and passes on its 404", async () => {
    answering("offline", 404);
    withCookies();

    const { PROVIDERS, NeedsEspnCookies } = await import("./providers.ts");
    const read = PROVIDERS["espn"]!.leaguesFor("77", 2026);

    await expect(read).rejects.toThrow("ESPN has no league 77 for season 2026.");
    await expect(read).rejects.not.toBeInstanceOf(NeedsEspnCookies);
  });
});

describe("espnSlotsOf", () => {
  it("reads a superflex league's lineup off ESPN's slot counts", () => {
    const counts = {
      "0": 1, "2": 2, "3": 1, "4": 2, "5": 1, "6": 1, "7": 1,
      "16": 1, "17": 1, "20": 7, "21": 1, "23": 1,
    };
    const slots = espnSlotsOf(counts).filter((s) => s !== "BN" && s !== "IR");

    expect(slots).toEqual([
      "QB", "RB", "RB", "WRRB_FLEX", "WR", "WR", "REC_FLEX", "TE",
      "SUPER_FLEX", "DEF", "K", "FLEX",
    ]);
    expect(slots.every(knownSlot)).toBe(true);
    expect(slotTakes("SUPER_FLEX", "QB")).toBe(true);
    expect(slotTakes("REC_FLEX", "RB")).toBe(false);
    expect(slotTakes("WRRB_FLEX", "TE")).toBe(false);
  });
});

describe("listedPlayers", () => {
  it("skips a listing at a position no lineup starts", () => {
    const listed = listedPlayers({
      "6794": { n: "Justin Jefferson", p: "WR", t: "MIN" },
      "13524": { n: "Justin Jefferson", p: "LB", t: "CLE", hurt: "Out" },
      "1": { n: "Tyler Boyd", p: "WR", t: "TEN", hurt: "Out" },
    });

    expect(listed.has("justinjefferson")).toBe(false);
    expect(listed.get("tylerboyd")?.status).toBe("Out");
  });

  it("lists a player under the board's key, team and position", () => {
    const listed = listedPlayers({
      "7670": { n: "Joshua Palmer", p: "WR", t: "BUF", hurt: "Questionable" },
      "11510": { n: "Hunter Luepke", p: "FB", t: "DAL", hurt: "Out" },
      "9": { n: "Kyren Williams", p: "RB", t: "LAR", hurt: "Doubtful" },
    });

    expect(listed.get("joshpalmer")?.status).toBe("Questionable");
    expect(listed.get("hunterluepke")?.position).toBe("RB");
    expect(listed.get("kyrenwilliams")?.team).toBe("LA");
  });
});

describe("sleeperOnBoard", () => {
  it("keys a defence by the board's code for its team", () => {
    expect(sleeperOnBoard({ n: "LAR", p: "DEF", t: "LAR" }))
      .toEqual({ key: "la", pos: "DEF", team: "LA" });
  });
});

describe("a player file in a tab left open", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("is read again once it is past its time, so a late ruling gets through", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // a Sunday morning on the east coast
    vi.setSystemTime(new Date("2030-10-06T14:00:00Z"));
    localStorage.clear();

    let asked = 0;

    globalThis.fetch = (() => {
      asked++;

      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        "1": {
          full_name: "Tyler Boyd", position: "WR", team: "TEN",
          injury_status: asked > 1 ? "Out" : null,
        },
      }) });
    }) as unknown as typeof fetch;

    const { sleeperPlayers } = await import("./providers.ts");

    await sleeperPlayers();
    await sleeperPlayers();

    expect(asked).toBe(1);

    vi.setSystemTime(new Date("2030-10-06T17:30:00Z"));

    const later = await sleeperPlayers();

    expect(asked).toBe(2);
    expect(later["1"]?.hurt).toBe("Out");
  });
});

describe("how long a cached player file is good for", () => {
  const hours = (at: string) => playerFileGoodFor(new Date(at)) / (60 * 60 * 1000);

  it("goes by the day on the east coast, wherever the browser is", () => {
    // Wednesday night in New York is already Thursday in London
    expect(hours("2026-09-17T02:00:00Z")).toBe(24);
    // and late Monday night there is Tuesday morning in Berlin
    expect(hours("2026-09-22T03:30:00Z")).toBe(3);
  });

  it("keeps it for the day early in the week", () => {
    expect(hours("2026-09-15T10:00:00")).toBe(24);
    expect(hours("2026-09-16T10:00:00")).toBe(24);
  });

  /** a player ruled out ninety minutes before kickoff has to get through */
  it("pulls it again every three hours on a game day", () => {
    expect(hours("2026-09-17T10:00:00")).toBe(3);
    expect(hours("2026-09-20T10:00:00")).toBe(3);
    expect(hours("2026-09-21T10:00:00")).toBe(3);
  });

  it("pulls it again every three hours once the final report is out", () => {
    expect(hours("2026-09-18T10:00:00")).toBe(3);
    expect(hours("2026-09-19T10:00:00")).toBe(3);
  });
});

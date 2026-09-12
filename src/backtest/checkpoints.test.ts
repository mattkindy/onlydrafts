import { describe, expect, it } from "vitest";
import {
  cacheHeader, cacheRows, checkpointsOf, fromCache, type PbpRow,
} from "./checkpoints.js";

const blank = {} as PbpRow;

/** one snap, with only the columns a test cares about filled in */
const snap = (fields: Partial<PbpRow>): PbpRow => ({
  ...blank,
  game_id: "2024_01_AAA_HHH", season: "2024", season_type: "REG", week: "1",
  home_team: "HHH", away_team: "AAA", posteam: "HHH", defteam: "AAA",
  qtr: "1", down: "1", ydstogo: "10", yardline_100: "75",
  game_seconds_remaining: "3600", total_home_score: "0", total_away_score: "0",
  posteam_timeouts_remaining: "3", defteam_timeouts_remaining: "3",
  play_type: "run", passer_player_id: "", passer_player_name: "",
  passing_yards: "", pass_touchdown: "0", interception: "0",
  receiver_player_id: "", receiver_player_name: "", receiving_yards: "",
  complete_pass: "0", rusher_player_id: "", rusher_player_name: "",
  rushing_yards: "", rush_touchdown: "0", fumbled_1_player_id: "",
  fumbled_1_player_name: "", fumble_lost: "0", two_point_attempt: "0",
  two_point_conv_result: "", fixed_drive: "1",
  ...fields,
});

const ran = (yards: number, fields: Partial<PbpRow> = {}) => snap({
  rusher_player_id: "back", rusher_player_name: "R.Back",
  rushing_yards: String(yards), ...fields,
});

describe("a game stopped at a snap", () => {
  const rows = [
    ran(10, { qtr: "1", game_seconds_remaining: "3500" }),
    ran(4, {
      qtr: "2", game_seconds_remaining: "2600", down: "3", ydstogo: "7",
      yardline_100: "40", total_home_score: "0",
    }),
    ran(6, {
      qtr: "3", game_seconds_remaining: "1700", yardline_100: "12",
      total_home_score: "7", total_away_score: "3",
      posteam_timeouts_remaining: "2",
    }),
    ran(3, {
      qtr: "4", game_seconds_remaining: "800", total_home_score: "14",
      total_away_score: "3",
    }),
  ];
  const stops = new Map(checkpointsOf(rows).map((one) => [one.label, one]));

  it("hands over the score before the snap, not after it", () => {
    expect(stops.get("half")?.state.points).toEqual({ HHH: 0, AAA: 0 });
    expect(stops.get("endQ3")?.state.points).toEqual({ HHH: 7, AAA: 3 });
  });

  it("hands over the down, the distance and the ball", () => {
    const third = stops.get("thirdQ2")?.state;

    expect(third?.down).toBe(3);
    expect(third?.toGo).toBe(7);
    expect(third?.yardline).toBe(40);
    expect(third?.withBall).toBe("HHH");
    expect(third?.secondHalf).toBe(false);
    expect(stops.get("endQ3")?.state.secondHalf).toBe(true);
  });

  it("takes a snap inside the twenty in the third quarter", () => {
    expect(stops.get("redQ3")?.state.yardline).toBe(12);
    expect(stops.get("redQ3")?.state.timeouts).toEqual({ HHH: 2, AAA: 3 });
  });

  it("splits a man's afternoon at the snap, in PPR", () => {
    const his = stops.get("half")?.men.find((man) => man.playerId === "back");

    expect(his?.soFar).toBeCloseTo(1.4, 6);
    expect(his?.toCome).toBeCloseTo(0.9, 6);
  });

  it("says what the two sides finished on", () => {
    expect(stops.get("endQ1")?.finalPoints).toEqual({ HHH: 14, AAA: 3 });
  });

  it("comes back out of its cache the way it went in", () => {
    const one = stops.get("half")!;
    const text = [cacheHeader(), ...cacheRows(one)].join("\n");
    const back = fromCache(text)[0]!;

    expect(back.state).toEqual(one.state);
    expect(back.men).toEqual(one.men);
    expect(back.finalPoints).toEqual(one.finalPoints);
  });
});

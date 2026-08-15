/**
 * Readers for the nflverse flat files in data/raw/. Each returns typed
 * rows filtered to the regular season, since fantasy leagues end before
 * the playoffs and postseason stats would distort per-game numbers.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import type { Game } from "../graph/types.js";
import type { RosterAppearance } from "../graph/build.js";
import { emptyStatLine, type StatLine } from "../scoring/fantasyPoints.js";

export const RAW_DIR = join(import.meta.dirname, "..", "..", "data", "raw");

export interface GameRow extends Game {
  spreadLine?: number;
  totalLine?: number;
}

export interface PlayerWeekStats {
  playerId: string;
  playerName: string;
  position: string;
  season: number;
  week: number;
  teamId: string;
  statLine: StatLine;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || value === "NA") {
    return undefined;
  }

  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

async function readRows(fileName: string): Promise<Record<string, string>[]> {
  const text = await readFile(join(RAW_DIR, fileName), "utf8");
  return parseCsv(text);
}

export async function loadGames(): Promise<GameRow[]> {
  const rows = await readRows("games.csv");

  return rows
    .filter((row) => row["game_type"] === "REG")
    .map((row) => ({
      id: row["game_id"] ?? "",
      season: toNumber(row["season"]) ?? 0,
      week: toNumber(row["week"]) ?? 0,
      homeTeamId: row["home_team"] ?? "",
      awayTeamId: row["away_team"] ?? "",
      spreadLine: toNumber(row["spread_line"]),
      totalLine: toNumber(row["total_line"]),
    }));
}

export async function loadWeeklyRosters(
  season: number,
): Promise<RosterAppearance[]> {
  const rows = await readRows(`roster_weekly_${season}.csv`);

  return rows
    .filter((row) => row["game_type"] === "REG" && row["gsis_id"])
    .map((row) => ({
      playerId: row["gsis_id"] ?? "",
      name: row["full_name"] ?? "",
      rawPosition: row["position"] ?? "",
      teamId: row["team"] ?? "",
      season: toNumber(row["season"]) ?? season,
      week: toNumber(row["week"]) ?? 0,
      college: row["college"] || undefined,
      draftYear: toNumber(row["entry_year"]),
      draftOverall: toNumber(row["draft_number"]),
    }));
}

export async function loadPlayerStats(
  season: number,
): Promise<PlayerWeekStats[]> {
  const rows = await readRows(`player_stats_${season}.csv`);

  return rows
    .filter((row) => row["season_type"] === "REG" && row["player_id"])
    .map((row) => {
      const n = (key: string) => toNumber(row[key]) ?? 0;

      const statLine: StatLine = {
        ...emptyStatLine(),
        passYds: n("passing_yards"),
        passTd: n("passing_tds"),
        interceptions: n("interceptions"),
        rushYds: n("rushing_yards"),
        rushTd: n("rushing_tds"),
        receptions: n("receptions"),
        recYds: n("receiving_yards"),
        recTd: n("receiving_tds"),
        fumblesLost:
          n("sack_fumbles_lost") +
          n("rushing_fumbles_lost") +
          n("receiving_fumbles_lost"),
        twoPointConversions:
          n("passing_2pt_conversions") +
          n("rushing_2pt_conversions") +
          n("receiving_2pt_conversions"),
      };

      return {
        playerId: row["player_id"] ?? "",
        playerName: row["player_display_name"] ?? row["player_name"] ?? "",
        position: row["position"] ?? "",
        season: toNumber(row["season"]) ?? season,
        week: toNumber(row["week"]) ?? 0,
        teamId: row["recent_team"] ?? "",
        statLine,
      };
    });
}

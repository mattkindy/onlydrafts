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

import { HOME } from "../features/climate.js";

export interface GameRow extends Game {
  spreadLine?: number;
  totalLine?: number;
  homeScore?: number;
  awayScore?: number;
  /** miles per hour at kickoff, absent indoors */
  wind?: number;
  temp?: number;
  /** a closed roof or a dome takes the weather out of it */
  indoors: boolean;
  /** grass or one of the several turfs, as the release writes it */
  surface?: string;
  /** the hour it kicks off, since an evening in December is colder */
  hour?: number;
  /** days since each side last played, 7 on a normal week */
  homeRest?: number;
  awayRest?: number;
  divisional: boolean;
}

export interface PlayerWeekStats {
  playerId: string;
  playerName: string;
  position: string;
  season: number;
  week: number;
  teamId: string;
  statLine: StatLine;
  targets: number;
  carries: number;
  airYards: number;
  /** yards he made after catching it, which is a different skill */
  yardsAfterCatch: number;
  /** his cut of what his own offence threw, already worked out upstream */
  targetShare: number;
  airYardsShare: number;
  /** what a quarterback did, so one can be described at all */
  passing: {
    attempts: number;
    completions: number;
    airYards: number;
    sacksTaken: number;
  };
  /** what a kicker and a return man did, which was also being dropped */
  kicking: {
    attempts: number;
    made: number;
    longest: number;
    /** from fifty and beyond, where legs separate */
    longAttempts: number;
    longMade: number;
    extraPoints: number;
  };
  returns: {
    yards: number;
    touchdowns: number;
  };
  /** and what a defender did, which was being thrown away entirely */
  defence: {
    tackles: number;
    tacklesForLoss: number;
    sacks: number;
    quarterbackHits: number;
    interceptions: number;
    passesDefended: number;
    forcedFumbles: number;
  };
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
      homeScore: toNumber(row["home_score"]),
      awayScore: toNumber(row["away_score"]),
      wind: toNumber(row["wind"]),
      // an empty reading turns into nought, which is a freezing day in
      // Miami rather than a missing one
      temp: toNumber(row["temp"]) || undefined,
      // A retractable ground is written as closed once it has been
      // played and left blank on a fixture nobody has played yet, so
      // where it is decides it rather than what the release says.
      indoors: /dome|closed/i.test(row["roof"] ?? "") ||
        ((row["roof"] ?? "") === "" &&
          (HOME[row["home_team"] ?? ""]?.indoors ?? false)),
      surface: (row["surface"] ?? "").replace(/"/g, "") || undefined,
      hour: toNumber((row["gametime"] ?? "").split(":")[0]),
      homeRest: toNumber(row["home_rest"]),
      awayRest: toNumber(row["away_rest"]),
      divisional: row["div_game"] === "1" || row["div_game"] === "TRUE",
    }));
}

/** roster files spell a few teams differently from the schedule file */
const TEAM_ALIASES: Record<string, string> = {
  AZ: "ARI",
  LAR: "LA",
  JAC: "JAX",
  WSH: "WAS",
  SL: "LA",
};

export function canonicalTeam(team: string): string {
  return TEAM_ALIASES[team] ?? team;
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
      teamId: canonicalTeam(row["team"] ?? ""),
      season: toNumber(row["season"]) ?? season,
      week: toNumber(row["week"]) ?? 0,
      college: row["college"] || undefined,
      draftYear: toNumber(row["entry_year"]),
      draftOverall: toNumber(row["draft_number"]),
      birthDate: row["birth_date"] || undefined,
      heightInches: toNumber(row["height"]),
      weightPounds: toNumber(row["weight"]),
      yearsExperience: toNumber(row["years_exp"]),
      depthPosition: row["depth_chart_position"] || undefined,
      status: row["status"] || undefined,
    }));
}

/** what the league says about a man rather than what he did */
export const EXEMPT = "EXE";

/**
 * The men on the commissioner's exempt list, most recently first.
 *
 * A man goes on it while he is charged with something and comes off it
 * when that ends, so the last week he appears is what says whether he
 * is still on it. It is a handful of players a season and every one of
 * them is worth nothing to a fantasy team for as long as it lasts.
 */
export async function exemptMen(
  season: number,
): Promise<Map<string, { name: string; team: string; lastWeek: number }>> {
  const found = new Map<string, { name: string; team: string; lastWeek: number }>();

  for (const row of await loadWeeklyRosters(season).catch(() => [])) {
    if (row.status !== EXEMPT) {
      continue;
    }

    const already = found.get(row.playerId);

    if (!already || row.week > already.lastWeek) {
      found.set(row.playerId, {
        name: row.name, team: row.teamId, lastWeek: row.week,
      });
    }
  }

  return found;
}

export interface SnapCountWeek {
  playerName: string;
  teamId: string;
  season: number;
  week: number;
  /** share of the team's offensive snaps this player was on the field for */
  offensePct: number;
}

export async function loadSnapCounts(season: number): Promise<SnapCountWeek[]> {
  const rows = await readRows(`snap_counts_${season}.csv`);

  return rows
    .filter((row) => row["game_type"] === "REG" && row["player"])
    .map((row) => ({
      playerName: row["player"] ?? "",
      teamId: canonicalTeam(row["team"] ?? ""),
      season: toNumber(row["season"]) ?? season,
      week: toNumber(row["week"]) ?? 0,
      offensePct: toNumber(row["offense_pct"]) ?? 0,
    }));
}

/**
 * A week with nothing in it, for tests and for anywhere a row has to
 * be built by hand. Spreading this means adding a column to
 * PlayerWeekStats does not break every fixture that mentions one.
 */
export function blankPlayerWeek(): Omit<PlayerWeekStats,
  "playerId" | "playerName" | "position" | "season" | "week" | "teamId"> {
  return {
    statLine: emptyStatLine(),
    targets: 0,
    carries: 0,
    airYards: 0,
    yardsAfterCatch: 0,
    targetShare: 0,
    airYardsShare: 0,
    passing: { attempts: 0, completions: 0, airYards: 0, sacksTaken: 0 },
    kicking: {
      attempts: 0, made: 0, longest: 0, longAttempts: 0, longMade: 0,
      extraPoints: 0,
    },
    returns: { yards: 0, touchdowns: 0 },
    defence: {
      tackles: 0, tacklesForLoss: 0, sacks: 0, quarterbackHits: 0,
      interceptions: 0, passesDefended: 0, forcedFumbles: 0,
    },
  };
}

export async function loadPlayerStats(
  season: number,
): Promise<PlayerWeekStats[]> {
  // nflverse renamed this release and widened it at the same time: the
  // new file has 150 columns where the old one has 53, and the kicking,
  // defensive and after-catch numbers are only in the new one. Read
  // that first and keep the old one as a fallback.
  const renamed = `stats_player_week_${season}.csv`;
  const legacy = `player_stats_${season}.csv`;
  const rows = await readRows(renamed).catch(() => readRows(legacy));

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
        teamId: canonicalTeam(row["recent_team"] ?? row["team"] ?? ""),
        statLine,
        targets: n("targets"),
        carries: n("carries"),
        airYards: n("receiving_air_yards"),
        yardsAfterCatch: n("receiving_yards_after_catch"),
        targetShare: n("target_share"),
        airYardsShare: n("air_yards_share"),
        passing: {
          attempts: n("attempts"),
          completions: n("completions"),
          airYards: n("passing_air_yards"),
          sacksTaken: n("sacks_suffered"),
        },
        kicking: {
          attempts: n("fg_att"),
          made: n("fg_made"),
          longest: n("fg_long"),
          longAttempts:
            n("fg_made_50_59") + n("fg_missed_50_59") +
            n("fg_made_60_") + n("fg_missed_60_"),
          longMade: n("fg_made_50_59") + n("fg_made_60_"),
          extraPoints: n("pat_made"),
        },
        returns: {
          yards: n("punt_return_yards") + n("kickoff_return_yards"),
          touchdowns: n("special_teams_tds"),
        },
        defence: {
          tackles: n("def_tackles_solo") + n("def_tackle_assists") * 0.5,
          tacklesForLoss: n("def_tackles_for_loss"),
          sacks: n("def_sacks"),
          quarterbackHits: n("def_qb_hits"),
          interceptions: n("def_interceptions"),
          passesDefended: n("def_pass_defended"),
          forcedFumbles: n("def_fumbles_forced"),
        },
      };
    });
}

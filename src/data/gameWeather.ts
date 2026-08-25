/**
 * The weather nflverse recorded at each game, and when each one kicked
 * off, pulled out of the games file.
 *
 * Only outdoor fixtures carry weather worth fitting, and a temperature
 * of nought means nobody wrote one down rather than a freezing
 * afternoon, so both are dropped here instead of at each caller.
 */

import type { Reading } from "../features/climate.js";

export interface Kickoff {
  season: number;
  week: number;
  homeTeam: string;
  awayTeam: string;
  /** local hour, so an evening in December can be told from an afternoon */
  hour: number;
  /** a roof takes the weather out of it, whether it is fixed or shut that day */
  indoors: boolean;
  /** days off before it, so a Thursday can be told from an ordinary week */
  homeRest: number;
  awayRest: number;
}

type Row = Record<string, string>;

const hourOf = (row: Row) => Number((row["gametime"] ?? "").split(":")[0]);

const outdoors = (row: Row) =>
  (row["roof"] ?? "") === "outdoors" || (row["roof"] ?? "") === "open";

export function readingsFrom(rows: Row[]): Reading[] {
  const out: Reading[] = [];

  for (const r of rows) {
    const temperature = Number(r["temp"]);
    const hour = hourOf(r);

    if (r["game_type"] !== "REG" || !outdoors(r) ||
        !Number.isFinite(temperature) || temperature === 0 ||
        r["temp"] === "NA" || !Number.isFinite(hour)) {
      continue;
    }

    out.push({
      team: r["home_team"] ?? "",
      week: Number(r["week"]),
      hour,
      temperature,
      wind: Number(r["wind"]),
    });
  }

  return out;
}

/** every fixture of a season, whether or not it has been played */
export function kickoffsIn(rows: Row[], season: number): Kickoff[] {
  const out: Kickoff[] = [];

  for (const r of rows) {
    if (r["game_type"] !== "REG" || Number(r["season"]) !== season) {
      continue;
    }

    const hour = hourOf(r);
    const roof = r["roof"] ?? "";
    const rest = (n: number) => Number.isFinite(n) ? n : 7;

    out.push({
      season,
      week: Number(r["week"]),
      homeTeam: r["home_team"] ?? "",
      awayTeam: r["away_team"] ?? "",
      // a fixture with no time yet is an afternoon, which most are
      hour: Number.isFinite(hour) ? hour : 13,
      indoors: roof === "dome" || roof === "closed",
      homeRest: rest(Number(r["home_rest"])),
      awayRest: rest(Number(r["away_rest"])),
    });
  }

  return out;
}

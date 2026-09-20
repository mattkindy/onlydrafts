/**
 * The forecast for each outdoor fixture that has not been played,
 * written by scripts/fetchWeather.ts and read by the slate.
 *
 * A row is keyed by the home ground, since that is where both sides
 * play, and the slate looks it up for whichever club is there that
 * week. `soaked` is what the weather tables in weekSetting were fitted
 * against, so the rule that decides it lives here rather than at each
 * caller.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import type { Weather } from "../features/weekSetting.js";

export const CURATED_DIR = join(
  import.meta.dirname, "..", "..", "data", "curated",
);

export const WEATHER_FILE = join(CURATED_DIR, "weatherWeekly.csv");

/** a millimetre over the three hours from kickoff is a wet ball */
export const SOAKED_MM = 1;

export interface Forecast extends Weather {
  season: number;
  week: number;
  homeTeam: string;
  /** millimetres over the three hours from kickoff */
  precipitation: number;
  /** the highest chance of any of those three hours, as a percentage */
  precipChance: number;
  /** whether this came from a forecast or from the ground's own history */
  source: "forecast" | "climate";
}

export const HEADER =
  "season,week,home_team,wind,temp,precip_mm,precip_chance,source";

export const rowOf = (f: Forecast): string =>
  [
    f.season, f.week, f.homeTeam,
    f.wind.toFixed(1), f.temperature.toFixed(1),
    f.precipitation.toFixed(2), f.precipChance.toFixed(0), f.source,
  ].join(",");

export function parseWeatherWeekly(text: string): Forecast[] {
  const out: Forecast[] = [];

  // an empty cell reads as zero through Number, which is a still
  // freezing afternoon rather than a missing one
  const num = (cell: string | undefined) =>
    cell === undefined || cell === "" || cell === "NA" ? NaN : Number(cell);

  for (const row of parseCsv(text)) {
    const wind = num(row["wind"]);
    const temperature = num(row["temp"]);
    const precipitation = num(row["precip_mm"]);

    if (!Number.isFinite(wind) || !Number.isFinite(temperature)) {
      continue;
    }

    out.push({
      season: Number(row["season"]),
      week: Number(row["week"]),
      homeTeam: row["home_team"] ?? "",
      wind,
      temperature,
      precipitation: Number.isFinite(precipitation) ? precipitation : 0,
      precipChance: num(row["precip_chance"]) || 0,
      soaked: Number.isFinite(precipitation) && precipitation >= SOAKED_MM,
      source: row["source"] === "climate" ? "climate" : "forecast",
    });
  }

  return out;
}

/** the forecasts on disk, or nothing at all when nobody has fetched any */
export async function loadWeatherWeekly(): Promise<Forecast[]> {
  return readFile(WEATHER_FILE, "utf8")
    .then(parseWeatherWeekly)
    .catch(() => []);
}

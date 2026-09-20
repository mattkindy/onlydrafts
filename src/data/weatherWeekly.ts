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
  /** falling, and cold enough that it is falling as snow */
  snow: boolean;
  /** whether this came from a forecast or from the ground's own history */
  source: "forecast" | "climate";
}

/** rain this cold is snow, which is what a kicking table treats it as */
const SNOWS_UNDER = 32;

/** the wind and the cold a day has to reach before anyone should be told */
const WORTH_SAYING_WIND = 15;
const WORTH_SAYING_COLD = 40;

/** what a card shows next to a name, where the day is worth a word */
export interface WeatherNote {
  wind: number;
  temp: number;
  wet: boolean;
  snow: boolean;
}

/**
 * A day mild enough to change nothing gets no note, so most rows carry
 * no weather at all and the slate stays small.
 */
export function weatherNote(
  f: Forecast | undefined,
): WeatherNote | undefined {
  if (!f) {
    return undefined;
  }

  const worth = f.wind >= WORTH_SAYING_WIND ||
    f.temperature < WORTH_SAYING_COLD || f.soaked;

  return worth
    ? {
      wind: Math.round(f.wind),
      temp: Math.round(f.temperature),
      wet: f.soaked && !f.snow,
      snow: f.snow,
    }
    : undefined;
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
      snow: Number.isFinite(precipitation) && precipitation >= SOAKED_MM &&
        temperature < SNOWS_UNDER,
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

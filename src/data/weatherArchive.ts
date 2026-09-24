/**
 * The rain and snow at a ground while a game was being played, which
 * nflverse does not record. Open-Meteo's archive gives an hour by hour
 * history back to 1940 for nothing, so each ground and season is pulled
 * once and cached under data/raw/weatherArchive, which is gitignored.
 *
 * Hours come back on Eastern time because that is what nflverse writes
 * a kickoff in, so a gameday and a gametime index the history without
 * anyone converting a zone.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "../features/climate.js";
import { fetchWithRetry } from "./fetchWithRetry.js";
import { RAW_DIR } from "./nflverse.js";
import { writeAtomically } from "./writeAtomically.js";

const ARCHIVE_DIR = join(RAW_DIR, "weatherArchive");
const ENDPOINT = "https://archive-api.open-meteo.com/v1/archive";

/** the hours a game is played over, counting from kickoff */
const GAME_HOURS = 3;

/** the club's own timekeeping, so a Sunday afternoon lands on hour 13 */
const ZONE = "America/New_York";

interface Hourly {
  time: string[];
  precipitation: number[];
  rain: number[];
  snowfall: number[];
  wind_speed_10m: number[];
  temperature_2m: number[];
}

/** what fell and blew at a ground over the three hours from kickoff */
export interface Sky {
  /** millimetres of everything, melted snow included */
  precipitation: number;
  /** centimetres of snow, which is the same water many times over */
  snowfall: number;
  /** miles an hour, averaged over the three */
  wind: number;
  /** Fahrenheit, averaged the same way */
  temperature: number;
}

/** a season runs from September into the February after it */
const rangeOf = (season: number) =>
  [`${season}-09-01`, `${season + 1}-02-20`] as const;

async function fromCache(path: string): Promise<Hourly | undefined> {
  return readFile(path, "utf8")
    .then((text) => JSON.parse(text) as Hourly)
    .catch(() => undefined);
}

async function download(team: string, season: number): Promise<Hourly> {
  const where = HOME[team];

  if (!where) {
    throw new Error(`no ground on file for ${team}`);
  }

  const [start, end] = rangeOf(season);
  const query = new URLSearchParams({
    latitude: String(where.latitude),
    longitude: String(where.longitude),
    start_date: start,
    end_date: end,
    hourly: "precipitation,rain,snowfall,wind_speed_10m,temperature_2m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "mm",
    timezone: ZONE,
  });

  const answer = await fetchWithRetry(`${ENDPOINT}?${query.toString()}`, {
    label: `Open-Meteo archive ${team} ${season}`,
  });

  if (!answer.ok) {
    throw new Error(
      `Open-Meteo said ${answer.status} for ${team} ${season}: ` +
        `${await answer.text()}`,
    );
  }

  const body = await answer.json() as { hourly?: Hourly };

  if (!body.hourly) {
    throw new Error(`Open-Meteo sent no hours for ${team} ${season}`);
  }

  return body.hourly;
}

/** one ground's season of hours, downloaded the first time and read after */
export async function hoursAt(
  team: string,
  season: number,
): Promise<Hourly | undefined> {
  const path = join(ARCHIVE_DIR, `${team}_${season}.json`);
  const cached = await fromCache(path);

  if (cached) {
    return cached;
  }

  if (!HOME[team]) {
    return undefined;
  }

  const hourly = await download(team, season);
  await mkdir(ARCHIVE_DIR, { recursive: true });
  await writeAtomically(path, JSON.stringify(hourly));

  return hourly;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The three hours from kickoff, averaged for wind and temperature and
 * added up for what fell. A gameday nobody has an hour for comes back
 * undefined rather than as a dry afternoon.
 */
export function skyAt(
  hourly: Hourly,
  gameday: string,
  hour: number,
): Sky | undefined {
  const first = hourly.time.indexOf(`${gameday}T${pad(hour)}:00`);

  if (first < 0) {
    return undefined;
  }

  const last = Math.min(first + GAME_HOURS, hourly.time.length);
  const over = (xs: number[]) => xs.slice(first, last).filter(Number.isFinite);
  const total = (xs: number[]) => over(xs).reduce((s, x) => s + x, 0);
  const middle = (xs: number[]) => {
    const kept = over(xs);

    return kept.length > 0 ? total(xs) / kept.length : NaN;
  };

  const sky = {
    precipitation: total(hourly.precipitation),
    snowfall: total(hourly.snowfall),
    wind: middle(hourly.wind_speed_10m),
    temperature: middle(hourly.temperature_2m),
  };

  return Number.isFinite(sky.wind) && Number.isFinite(sky.temperature)
    ? sky
    : undefined;
}

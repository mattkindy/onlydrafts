/**
 * The forecast for every outdoor fixture left in the season, into
 * data/curated/weatherWeekly.csv, one request per ground from
 * Open-Meteo. A fixture past the sixteen days Open-Meteo forecasts
 * falls back to the ground's own history, which is the same climate fit
 * the season sim walks its games through.
 *
 * Run: npx tsx scripts/fetchWeather.ts [--season 2026]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchWithRetry } from "../src/data/fetchWithRetry.js";
import { writeAtomically } from "../src/data/writeAtomically.js";
import {
  comingWeek, currentSeason, loadGames, RAW_DIR,
} from "../src/data/nflverse.js";
import { parseCsv } from "../src/data/csv.js";
import { fitClimate, HOME } from "../src/features/climate.js";
import { readingsFrom } from "../src/data/gameWeather.js";
import {
  HEADER, rowOf, SOAKED_MM, WEATHER_FILE, type Forecast,
} from "../src/data/weatherWeekly.js";

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/** the hours a game is played over, counting from kickoff */
const GAME_HOURS = 3;

/** nflverse writes a kickoff on Eastern time, so the hours come back on it */
const ZONE = "America/New_York";

/** how far ahead Open-Meteo will go */
const HORIZON_DAYS = 16;

/** a gap between requests, since the service is free and asks nothing back */
const POLITE_MS = 250;

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Hourly {
  time: string[];
  precipitation: number[];
  precipitation_probability: number[];
  wind_speed_10m: number[];
  temperature_2m: number[];
}

async function forecastAt(team: string): Promise<Hourly | undefined> {
  const where = HOME[team];

  if (!where) {
    return undefined;
  }

  const query = new URLSearchParams({
    latitude: String(where.latitude),
    longitude: String(where.longitude),
    hourly:
      "precipitation,precipitation_probability,wind_speed_10m,temperature_2m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "mm",
    timezone: ZONE,
    forecast_days: String(HORIZON_DAYS),
  });

  const answer = await fetchWithRetry(`${ENDPOINT}?${query.toString()}`, {
    label: `Open-Meteo ${team}`,
  });

  if (!answer.ok) {
    console.error(`Open-Meteo said ${answer.status} for ${team}`);
    return undefined;
  }

  return (await answer.json() as { hourly?: Hourly }).hourly;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** the three hours from kickoff, if the forecast reaches that far */
function overTheGame(hourly: Hourly, gameday: string, hour: number) {
  const first = hourly.time.indexOf(`${gameday}T${pad(hour)}:00`);

  if (first < 0) {
    return undefined;
  }

  const last = Math.min(first + GAME_HOURS, hourly.time.length);
  const over = (xs: number[] | undefined) =>
    (xs ?? []).slice(first, last).filter(Number.isFinite);
  const middle = (xs: number[] | undefined) => {
    const kept = over(xs);

    return kept.length > 0
      ? kept.reduce((s, x) => s + x, 0) / kept.length
      : NaN;
  };

  const wind = middle(hourly.wind_speed_10m);
  const temperature = middle(hourly.temperature_2m);

  if (!Number.isFinite(wind) || !Number.isFinite(temperature)) {
    return undefined;
  }

  return {
    wind,
    temperature,
    precipitation: over(hourly.precipitation).reduce((s, x) => s + x, 0),
    precipChance: Math.max(0, ...over(hourly.precipitation_probability)),
  };
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--season");
  const season = flag === -1
    ? currentSeason()
    : Number(process.argv[flag + 1]);

  const games = await loadGames();
  const from = comingWeek(games, season);
  // a week is coming as long as one of its games is, so the ones
  // already played are dropped rather than forecast backwards
  const left = games.filter(
    (g) => g.season === season && g.week >= from && !g.indoors &&
      g.homeScore === undefined && g.gameday && HOME[g.homeTeamId],
  );

  if (left.length === 0) {
    console.log(`no outdoor fixtures left in ${season} from week ${from}`);
    return;
  }

  const gameRows = parseCsv(await readFile(join(RAW_DIR, "games.csv"), "utf8"));
  const climate = fitClimate(readingsFrom(gameRows));
  const grounds = [...new Set(left.map((g) => g.homeTeamId))].sort();
  const hourlies = new Map<string, Hourly | undefined>();

  for (const team of grounds) {
    hourlies.set(team, await forecastAt(team).catch((error: unknown) => {
      console.error(`no forecast for ${team}: ${String(error)}`);
      return undefined;
    }));
    await wait(POLITE_MS);
  }

  const rows: Forecast[] = [];

  for (const game of left) {
    const hour = game.hour ?? 13;
    const hourly = hourlies.get(game.homeTeamId);
    const said = hourly ? overTheGame(hourly, game.gameday!, hour) : undefined;

    // Past sixteen days nobody has a forecast, so we use what the
    // ground usually gets. A mean afternoon is dry and mild, which
    // leaves the weather tables doing almost nothing.
    const taken = said ?? {
      wind: climate.meanWind(game.homeTeamId),
      temperature: climate.meanTemperature(game.homeTeamId, game.week, hour),
      precipitation: 0,
      precipChance: 0,
    };

    rows.push({
      season,
      week: game.week,
      homeTeam: game.homeTeamId,
      ...taken,
      soaked: taken.precipitation >= SOAKED_MM,
      snow: taken.precipitation >= SOAKED_MM && taken.temperature < 32,
      source: said ? "forecast" : "climate",
    });
  }

  rows.sort((a, b) => a.week - b.week || a.homeTeam.localeCompare(b.homeTeam));

  await writeAtomically(
    WEATHER_FILE, [HEADER, ...rows.map(rowOf)].join("\n") + "\n",
  );

  const forecast = rows.filter((r) => r.source === "forecast").length;
  console.log(
    `${rows.length} outdoor fixtures from week ${from}, ${forecast} of them ` +
      `forecast and ${rows.length - forecast} from the ground's history`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

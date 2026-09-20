/**
 * Warms the Open-Meteo hour by hour history for every ground a regular
 * season game was played at, one request per ground per season, into
 * data/raw/weatherArchive. A ground already cached is skipped, so this
 * is safe to rerun and cheap the second time.
 *
 * Run: npx tsx scripts/fetchWeatherArchive.ts
 */

import { loadGames } from "../src/data/nflverse.js";
import { hoursAt } from "../src/data/weatherArchive.js";

const SEASONS = [
  2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
];

/** a gap between requests, since the service is free and asks nothing back */
const POLITE_MS = 250;

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function main(): Promise<void> {
  const games = await loadGames();
  const wanted = new Set<string>();

  for (const game of games) {
    if (SEASONS.includes(game.season)) {
      wanted.add(`${game.homeTeamId}|${game.season}`);
    }
  }

  const keys = [...wanted].sort();
  let ready = 0;

  for (const key of keys) {
    const [team, season] = key.split("|");
    const hourly = await hoursAt(team!, Number(season)).catch(
      (error: unknown) => {
        console.error(`${key}: ${String(error)}`);
        return undefined;
      },
    );

    if (hourly) {
      ready += 1;
    }

    console.log(`${ready}/${keys.length} ${key}`);
    await wait(POLITE_MS);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

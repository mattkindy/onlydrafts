/**
 * Does the weather move how many drives a game has?
 *
 * The walk orders how many drives a side gets at .113 against a
 * ceiling near .37, and it knows nothing about the conditions. Wind
 * and cold push sides to run, which keeps the clock going, and a
 * running clock means fewer possessions.
 *
 * Temperature and wind are on 58% of games since 2021, the roof on
 * all of them.
 *
 * Run: npx tsx scripts/weatherDriveCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const drives = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
  ));
  const count = new Map<string, number>();

  for (const row of drives) {
    if (Number(row["week"]) > 18) {
      continue;
    }

    count.set(
      `${row["season"]}|${row["week"]}|${row["offense"]}`,
      (count.get(`${row["season"]}|${row["week"]}|${row["offense"]}`) ?? 0) + 1,
    );
  }

  const scored = new Map<string, number>();

  for (const row of drives) {
    if (Number(row["week"]) > 18) {
      continue;
    }

    const key = `${row["season"]}|${row["week"]}|${row["offense"]}`;
    scored.set(key, (scored.get(key) ?? 0) + Number(row["points"]));
  }

  // and how they chose to move it, since that is what weather is
  // usually said to change
  const threw = new Map<string, number>();
  const ran = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ))) {
    if (Number(row["week"]) > 18 || Number(row["season"]) < 2021) {
      continue;
    }

    const key = `${row["season"]}|${row["week"]}|${row["offense"]}`;
    ran.set(key, (ran.get(key) ?? 0) + 1);
    if (row["playType"] === "pass") threw.set(key, (threw.get(key) ?? 0) + 1);
  }

  const games = parseCsv(await readFile(join(RAW_DIR, "games.csv"), "utf8"));
  interface Game {
    drives: number;
    points: number;
    passes: number;
    plays: number;
    temp?: number;
    wind?: number;
    indoors: boolean;
  }
  const played: Game[] = [];

  for (const game of games) {
    const season = Number(game["season"]);

    if (season < 2021 || Number(game["week"]) > 18) {
      continue;
    }

    const home = count.get(`${season}|${game["week"]}|${game["home_team"]}`);
    const away = count.get(`${season}|${game["week"]}|${game["away_team"]}`);

    if (home === undefined || away === undefined) {
      continue;
    }

    const temp = Number(game["temp"]);
    const wind = Number(game["wind"]);
    const key = `${season}|${game["week"]}`;
    played.push({
      drives: home + away,
      points: (scored.get(`${key}|${game["home_team"]}`) ?? 0) +
        (scored.get(`${key}|${game["away_team"]}`) ?? 0),
      passes: (threw.get(`${key}|${game["home_team"]}`) ?? 0) +
        (threw.get(`${key}|${game["away_team"]}`) ?? 0),
      plays: (ran.get(`${key}|${game["home_team"]}`) ?? 0) +
        (ran.get(`${key}|${game["away_team"]}`) ?? 0),
      temp: Number.isFinite(temp) && game["temp"] !== "" ? temp : undefined,
      wind: Number.isFinite(wind) && game["wind"] !== "" ? wind : undefined,
      indoors: (game["roof"] ?? "") !== "outdoors",
    });
  }

  console.log(`${played.length} games\n`);
  console.log("how many drives a game has, by the conditions\n");
  console.log(
    "  conditions              games   drives    points   throws   " +
      "points against all",
  );

  const all = middle(played.map((g) => g.drives));
  const allPoints = middle(played.map((g) => g.points));
  const cuts: [string, (g: Game) => boolean][] = [
    ["under a roof", (g) => g.indoors],
    ["out in the open", (g) => !g.indoors],
    ["colder than 40", (g) => (g.temp ?? 99) < 40],
    ["warmer than 70", (g) => (g.temp ?? 0) > 70],
    ["wind over 15", (g) => (g.wind ?? 0) > 15],
    ["wind under 5", (g) => (g.wind ?? 99) < 5],
  ];

  for (const [label, is] of cuts) {
    const these = played.filter(is);

    if (these.length < 40) {
      continue;
    }

    const mid = middle(these.map((g) => g.drives));
    const points = middle(these.map((g) => g.points));
    const passing = middle(these.map((g) => g.plays > 0 ? g.passes / g.plays : 0));
    console.log(
      "  " + label.padEnd(24) + String(these.length).padStart(5) +
        mid.toFixed(2).padStart(9) + points.toFixed(1).padStart(10) +
        `${(100 * passing).toFixed(0)}%`.padStart(9) +
        `${(points - allPoints >= 0 ? "+" : "")}${(points - allPoints).toFixed(1)}`.padStart(14),
    );
  }

  console.log(
    `\n  every game averages ${all.toFixed(2)} drives and ` +
      `${allPoints.toFixed(1)} points`,
  );

  /**
   * The same cuts on what the visiting side scored, against what it
   * scores everywhere else that season.
   *
   * Which sides play indoors is not a coin toss: a dome belongs to a
   * particular club. Stadium effects measured without holding the
   * visitor still vanished once it was held still, so the roof wants
   * asking the same way. A visitor brings its own scoring with it and
   * only the conditions change.
   */
  console.log("\n  and the same on the visiting side alone\n");
  console.log("  conditions              games   they scored   against their own year");

  const visiting: { points: number; usual: number; game: Game }[] = [];

  for (const game of games) {
    const season = Number(game["season"]);

    if (season < 2021 || Number(game["week"]) > 18) {
      continue;
    }

    const away = game["away_team"] ?? "";
    const scoredHere = scored.get(`${season}|${game["week"]}|${away}`);

    if (scoredHere === undefined) {
      continue;
    }

    const theirs = [...scored.entries()]
      .filter(([key]) => key.startsWith(`${season}|`) && key.endsWith(`|${away}`))
      .map(([, n]) => n);

    if (theirs.length < 8) {
      continue;
    }

    const temp = Number(game["temp"]);
    const wind = Number(game["wind"]);
    visiting.push({
      points: scoredHere,
      usual: middle(theirs),
      game: {
        drives: 0, points: 0, passes: 0, plays: 0,
        temp: Number.isFinite(temp) && game["temp"] !== "" ? temp : undefined,
        wind: Number.isFinite(wind) && game["wind"] !== "" ? wind : undefined,
        indoors: (game["roof"] ?? "") !== "outdoors",
      },
    });
  }

  for (const [label, is] of cuts) {
    const these = visiting.filter((v) => is(v.game));

    if (these.length < 40) {
      continue;
    }

    const gap = middle(these.map((v) => v.points - v.usual));
    console.log(
      "  " + label.padEnd(24) + String(these.length).padStart(5) +
        middle(these.map((v) => v.points)).toFixed(1).padStart(14) +
        `${gap >= 0 ? "+" : ""}${gap.toFixed(2)}`.padStart(24),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

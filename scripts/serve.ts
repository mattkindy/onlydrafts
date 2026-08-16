// Local web UI for the weekly tools: trains the model once, then
// serves predictions and Sleeper league rosters to the page.
// Run: npx tsx scripts/serve.ts   then open http://localhost:3210

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames } from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyProspectiveForWeek,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import {
  buildResidualModel,
  outcomeQuantile,
  type ResidualModel,
} from "../src/backtest/intervals.js";
import {
  fetchLeagueRosters,
  fetchSleeperPlayers,
} from "../src/data/sleeper.js";
import { normalizeName } from "../src/data/names.js";

const PORT = 3210;
const LAST_COMPLETE_SEASON = 2025;

let weights: number[];
let residuals: ResidualModel;
const slateCache = new Map<string, object>();

async function train(): Promise<void> {
  console.log("training the weekly model, about a minute...");
  const games = await loadGames();
  const train: WeeklyExample[] = [];

  for (let s = 2016; s <= LAST_COMPLETE_SEASON; s++) {
    train.push(...(await weeklyExamplesForSeason(s, games)));
    console.log(`  ${s} loaded`);
  }

  weights = fitRidge(train.map(weeklyRow), train.map((e) => e.target), 25);
  residuals = buildResidualModel(
    train.map((e) => ({
      position: e.position,
      predicted: predictRidge(weights, weeklyRow(e)),
      actual: e.target,
    })),
    5,
  );
  console.log("ready");
}

async function slate(season: number, week: number): Promise<object> {
  const key = `${season}|${week}`;
  const cached = slateCache.get(key);

  if (cached) {
    return cached;
  }

  const games = await loadGames();
  const rows = (await weeklyProspectiveForWeek(season, week, games))
    .map((e) => {
      const predicted = predictRidge(weights, weeklyRow(e));
      return {
        name: e.playerName,
        key: normalizeName(e.playerName),
        position: e.position,
        team: e.teamId,
        opponent: (e.home ? "v " : "@ ") + e.opponent,
        predicted: Number(predicted.toFixed(1)),
        floor: Number(
          outcomeQuantile(residuals, e.position, predicted, 0.1).toFixed(1),
        ),
        ceiling: Number(
          outcomeQuantile(residuals, e.position, predicted, 0.9).toFixed(1),
        ),
        snaps: Math.round(e.snapRecent * 100),
      };
    })
    .sort((a, b) => b.predicted - a.predicted);
  const result = { season, week, players: rows };
  slateCache.set(key, result);
  return result;
}

async function league(leagueId: string): Promise<object> {
  const [players, rosters] = await Promise.all([
    fetchSleeperPlayers(),
    fetchLeagueRosters(leagueId),
  ]);

  return {
    rosters: rosters.map((r) => ({
      owner: r.ownerName,
      players: r.playerIds
        .map((id) => players.get(id))
        .filter((p): p is NonNullable<typeof p> => p !== undefined)
        .map((p) => ({ key: normalizeName(p.name), name: p.name })),
    })),
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/") {
      const html = await readFile(
        join(import.meta.dirname, "..", "tools", "ui", "index.html"),
        "utf8",
      );
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }

    if (url.pathname === "/api/slate") {
      const season = Number(url.searchParams.get("season") ?? LAST_COMPLETE_SEASON);
      const week = Number(url.searchParams.get("week") ?? 10);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await slate(season, week)));
      return;
    }

    if (url.pathname === "/api/league") {
      const leagueId = url.searchParams.get("id") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await league(leagueId)));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

train().then(() => {
  server.listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
  });
});

// Builds the static weekly site into docs/: the page plus prediction
// JSON for the requested weeks, ready for GitHub Pages.
// Run: npx tsx scripts/buildSite.ts --season 2025 --weeks 10-12

import { mkdir, writeFile, readFile } from "node:fs/promises";
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
} from "../src/backtest/intervals.js";
import { normalizeName } from "../src/data/names.js";
import { buildPreseasonWorld } from "../src/features/preseason.js";
import { simulatePlayerSeasons } from "../src/sim/playerSeason.js";
import { seededRng } from "../src/sim/rng.js";
import { loadAdp } from "../src/data/adp.js";

const DOCS = join(import.meta.dirname, "..", "docs", "weekly");

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1]!;
}

async function main(): Promise<void> {
  const season = Number(argOf("--season", "2025"));
  const weeksArg = argOf("--weeks", "");
  const range = weeksArg.match(/^(\d+)-(\d+)$/);
  const weeks = weeksArg === ""
    ? []
    : range
    ? Array.from(
        { length: Number(range[2]) - Number(range[1]) + 1 },
        (_, i) => Number(range[1]) + i,
      )
      : weeksArg.split(",").map(Number);

  const games = await loadGames();
  const train: WeeklyExample[] = [];

  for (let s = 2016; s < season; s++) {
    train.push(...(await weeklyExamplesForSeason(s, games)));
  }

  const weights = fitRidge(train.map(weeklyRow), train.map((e) => e.target), 25);
  const residuals = buildResidualModel(
    train.map((e) => ({
      position: e.position,
      predicted: predictRidge(weights, weeklyRow(e)),
      actual: e.target,
    })),
    5,
  );

  await mkdir(join(DOCS, "data"), { recursive: true });

  const index: { season: number; week: number }[] = [];

  for (const week of weeks) {
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

    await writeFile(
      join(DOCS, "data", `slate-${season}-${week}.json`),
      JSON.stringify({ season, week, players: rows }),
    );
    index.push({ season, week });
    console.log(`week ${week}: ${rows.length} players`);
  }

  // season draft board with replacement value, for the draft view
  const world = await buildPreseasonWorld(season);
  const { projectDraftExamples } = await import("../src/features/seasonModel.js");
  const draftExamples = await projectDraftExamples(season, world.data);
  const exampleById = new Map(draftExamples.map((e) => [e.playerId, e]));

  const weekOpp = new Map<string, { week: number; opponent: string; home: boolean }[]>();

  for (const game of world.games) {
    if (game.season !== season || game.week > 17) {
      continue;
    }

    for (const [team, opponent, home] of [
      [game.homeTeamId, game.awayTeamId, true],
      [game.awayTeamId, game.homeTeamId, false],
    ] as [string, string, boolean][]) {
      const list = weekOpp.get(team) ?? [];
      list.push({ week: game.week, opponent, home });
      weekOpp.set(team, list);
    }
  }

  const factors = (playerId: string, ppg: number) => {
    const e = exampleById.get(playerId);
    const plus: string[] = [];
    const minus: string[] = [];

    if (!e) {
      return { plus, minus };
    }

    if (e.moved) {
      minus.push("changed teams; movers keep about 89% of production");
    }

    if (e.group === "skill-stayer-new-qb") {
      minus.push("new starting quarterback");
    }

    if (e.hcChanged) {
      minus.push("new coaching regime; stayers under one keep about 96%");
    } else if (e.ocChanged) {
      plus.push("coordinator change under the same head coach, historically harmless");
    }

    if (e.ocReunion) {
      plus.push("reunited with a former coordinator");
    }

    if (e.age !== undefined && e.age >= 29) {
      minus.push(e.position === "RB" ? `age ${e.age}, past the RB cliff` : `age ${e.age}`);
    }

    if (e.expYears !== undefined && e.expYears <= 3) {
      plus.push("years one to three, when players typically improve");
    }

    if (e.gamesPrev <= 12) {
      minus.push(`only ${e.gamesPrev} games last season`);
    }

    if (e.tdPointShare >= 0.45) {
      minus.push("touchdown-heavy scoring, which regresses");
    }

    if (e.rookieCapital >= 0.5) {
      minus.push("team drafted a high pick at his position");
    }

    if (e.targetsPerGame >= 7) {
      plus.push(`${e.targetsPerGame.toFixed(1)} targets a game, and volume repeats`);
    }

    if (e.carriesPerGame >= 14) {
      plus.push(`${e.carriesPerGame.toFixed(1)} carries a game, a workhorse role`);
    }

    if (e.prevPpg > 0 && ppg > e.prevPpg + 1) {
      plus.push(`model projects ${ppg.toFixed(1)}, above last season's ${e.prevPpg.toFixed(1)}`);
    } else if (e.prevPpg > 0 && ppg < e.prevPpg - 1.5) {
      minus.push(`model projects ${ppg.toFixed(1)}, below last season's ${e.prevPpg.toFixed(1)}`);
    }

    return { plus, minus };
  };
  const REPLACEMENT_RANK: Record<string, number> = { QB: 20, RB: 40, WR: 40, TE: 16 };
  const replacement = new Map<string, number>();

  for (const position of Object.keys(REPLACEMENT_RANK)) {
    const list = world.players
      .filter((p) => p.position === position)
      .sort((a, b) => b.projectedPpg - a.projectedPpg);
    const at = list[Math.min(REPLACEMENT_RANK[position]!, list.length) - 1];
    replacement.set(position, at?.projectedPpg ?? 0);
  }

  const adp = await loadAdp(season).catch(() => new Map());
  console.log("simulating seasons for the board...");
  const sims = simulatePlayerSeasons(
    world.players,
    season,
    world.games,
    world.residuals,
    world.oppAdjust,
    world.catcherLoading,
    2000,
    seededRng(17),
    world.seasonNoise,
  );
  const simById = new Map(sims.map((s) => [s.playerId, s]));

  const board = world.players
    .map((p) => {
      const f = factors(p.playerId, p.projectedPpg);
      const sim = simById.get(p.playerId);
      return {
        name: p.name,
        key: normalizeName(p.name),
        position: p.position,
        team: p.teamId,
        ppg: Number(p.projectedPpg.toFixed(1)),
        vor: Number(
          (p.projectedPpg - (replacement.get(p.position) ?? 0)).toFixed(1),
        ),
        adp: adp.get(`${normalizeName(p.name)}|${p.position}`)?.adp ?? null,
        bye: world.byeWeek.get(p.teamId) ?? null,
        sim: sim
          ? {
              mean: Math.round(sim.meanTotal),
              low: Math.round(sim.p10),
              mid: Math.round(sim.p50),
              high: Math.round(sim.p90),
              games: Number(sim.meanGames.toFixed(1)),
            }
          : null,
        plus: f.plus,
        minus: f.minus,
        weeks: (weekOpp.get(p.teamId) ?? [])
          .sort((a, b) => a.week - b.week)
          .map((g) => ({
            w: g.week,
            opp: (g.home ? "v " : "@ ") + g.opponent,
            pts: Number((p.projectedPpg * world.oppAdjust(p.position, g.opponent)).toFixed(1)),
          })),
      };
    })
    .sort((a, b) => b.vor - a.vor);

  await writeFile(
    join(DOCS, "data", `board-${season}.json`),
    JSON.stringify({ season, players: board }),
  );
  console.log(`board: ${board.length} players`);

  await writeFile(
    join(DOCS, "data", "index.json"),
    JSON.stringify({ weeks: index, boardSeason: season }),
  );
  await writeFile(
    join(DOCS, "index.html"),
    await readFile(join(import.meta.dirname, "..", "tools", "ui", "index.html"), "utf8"),
  );
  console.log(`site written to ${DOCS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

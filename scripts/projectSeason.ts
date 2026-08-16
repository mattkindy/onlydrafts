// Season totals by simulation: every player's schedule simulated with
// correlated weekly draws and availability, summed to a distribution.
// Run: npx tsx scripts/projectSeason.ts --season 2025

import { loadGames, loadWeeklyRosters } from "../src/data/nflverse.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
  projectDraftExamples,
  type SeasonExample,
} from "../src/features/seasonModel.js";
import {
  fitRookieModel,
  predictRookie,
  rookiesFor,
} from "../src/features/rookies.js";
import {
  weeklyExamplesForSeason,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildSeasonNoise } from "../src/backtest/intervals.js";
import { loadTendencies } from "../src/data/tendencies.js";
import { seededRng } from "../src/sim/rng.js";
import {
  simulatePlayerSeasons,
  type SeasonPlayer,
} from "../src/sim/playerSeason.js";
import { presets, fantasyPoints } from "../src/scoring/fantasyPoints.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { spearman } from "../src/backtest/metrics.js";

const SIMS = 1000;

function argOf(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}

async function main(): Promise<void> {
  const season = argOf("--season", 2025);
  const games = await loadGames();
  const seasons: number[] = [];

  for (let s = 2015; s <= season; s++) {
    seasons.push(s);
  }

  const data = await buildSeasonData(seasons);
  const train: SeasonExample[] = [];

  for (const target of seasons.filter((s) => s >= 2017 && s < season)) {
    train.push(...(await examplesForTransition(target, data)));
  }

  const fit = fitSeasonModel(train);
  const board = await projectDraftExamples(season, data);

  const rookieTrain = [];

  for (const t of seasons.filter((s) => s >= 2017 && s < season)) {
    rookieTrain.push(...(await rookiesFor(t, data, games)));
  }

  const rookieWeights = fitRookieModel(rookieTrain);
  const rookieClass = await rookiesFor(season, data, games);

  // availability pools: how many games players like this actually played
  // the next season, including the zeros the season filter hides
  const bucketOf = (gamesPrev: number) =>
    gamesPrev >= 14 ? "durable" : gamesPrev >= 9 ? "spotty" : "thin";
  const gamesPools = new Map<string, number[]>([
    ["durable", []],
    ["spotty", []],
    ["thin", []],
    ["rookie", []],
  ]);

  for (const target of seasons.filter((s) => s >= 2017 && s < season)) {
    const prevSummaries = data.get(target - 1)!.summaries;
    const targetSummaries = data.get(target)!.summaries;

    for (const was of prevSummaries.values()) {
      if (!["QB", "RB", "WR", "TE"].includes(was.position) || was.games < 6) {
        continue;
      }

      gamesPools
        .get(bucketOf(was.games))!
        .push(targetSummaries.get(was.playerId)?.games ?? 0);
    }
  }

  for (const r of rookieTrain) {
    gamesPools.get("rookie")!.push(r.actualGames);
  }

  // weekly residuals for the outcome distributions
  const weeklyTrain: WeeklyExample[] = [];

  for (const s of seasons.filter((x) => x >= 2016 && x < season)) {
    weeklyTrain.push(...(await weeklyExamplesForSeason(s, games)));
  }

  const weeklyWeights = fitRidge(
    weeklyTrain.map(weeklyRow),
    weeklyTrain.map((e) => e.target),
    25,
  );
  const seasonNoise = buildSeasonNoise(
    weeklyTrain.map((e) => ({
      playerId: e.playerId,
      season: e.season,
      position: e.position,
      predicted: predictRidge(weeklyWeights, weeklyRow(e)),
      actual: e.target,
    })),
    5,
  );
  const residuals = seasonNoise.within;

  // opponent strength from the prior season's points allowed by position
  const prevStats = data.get(season - 1)!.stats;
  const prevSchedule = new Map<string, string>();

  for (const game of games) {
    if (game.season !== season - 1) {
      continue;
    }

    prevSchedule.set(`${game.homeTeamId}|${game.week}`, game.awayTeamId);
    prevSchedule.set(`${game.awayTeamId}|${game.week}`, game.homeTeamId);
  }

  const allowed = new Map<string, { points: number; games: Set<string> }>();
  const league = new Map<string, number>();

  for (const row of prevStats) {
    if (!["QB", "RB", "WR", "TE"].includes(row.position)) {
      continue;
    }

    const defense = prevSchedule.get(`${row.teamId}|${row.week}`);

    if (!defense) {
      continue;
    }

    const points = fantasyPoints(row.statLine, presets.ppr);
    const key = `${defense}|${row.position}`;
    const entry = allowed.get(key) ?? { points: 0, games: new Set<string>() };
    entry.points += points;
    entry.games.add(String(row.week));
    allowed.set(key, entry);
    league.set(row.position, (league.get(row.position) ?? 0) + points);
  }

  const leaguePerTeamGame = new Map<string, number>();

  for (const [position, points] of league) {
    leaguePerTeamGame.set(position, points / (32 * 17));
  }

  const oppAdjust = (position: string, opponent: string): number => {
    const entry = allowed.get(`${opponent}|${position}`);
    const mean = leaguePerTeamGame.get(position);

    if (!entry || !mean || entry.games.size === 0) {
      return 1;
    }

    const index = entry.points / entry.games.size / mean;
    return 1 + 0.12 * (index - 1);
  };

  // team assignment and coach-scaled stack correlation
  const roster = await loadWeeklyRosters(season);
  const teamOf = new Map<string, string>();

  for (const appearance of roster) {
    if (appearance.week === 1) {
      teamOf.set(appearance.playerId, appearance.teamId);
    }
  }

  const tendencies = await loadTendencies();
  const catcherLoading = new Map<string, number>();

  for (const [key, tendency] of tendencies) {
    const [team, s] = key.split("|");

    if (Number(s) === season - 1) {
      catcherLoading.set(team!, 0.207 * (tendency.neutralPassRate / 0.57));
    }
  }

  const players: SeasonPlayer[] = [];
  const names = data.get(season - 1)!.summaries;

  for (const e of board) {
    const team = teamOf.get(e.playerId);

    if (!team) {
      continue;
    }

    players.push({
      playerId: e.playerId,
      name: names.get(e.playerId)?.playerName ?? e.playerId,
      position: e.position,
      teamId: team,
      projectedPpg: predictSeasonBlend(fit, e),
      gamesPool: gamesPools.get(bucketOf(e.gamesPrev))!,
    });
  }

  for (const r of rookieClass) {
    const team = teamOf.get(r.playerId);

    if (!team) {
      continue;
    }

    players.push({
      playerId: r.playerId,
      name: r.name,
      position: r.position,
      teamId: team,
      projectedPpg: predictRookie(rookieWeights, r),
      gamesPool: gamesPools.get("rookie")!,
    });
  }

  const projections = simulatePlayerSeasons(
    players,
    season,
    games,
    residuals,
    oppAdjust,
    catcherLoading,
    SIMS,
    seededRng(11),
    seasonNoise,
  ).sort((a, b) => b.meanTotal - a.meanTotal);

  console.log(`${season} season totals from ${SIMS} simulated seasons, top 20:`);
  console.log("player                      pos   mean    p10    p50    p90  games");

  for (const p of projections.slice(0, 20)) {
    console.log(
      `${p.name.padEnd(27)} ${p.position.padEnd(3)} ${p.meanTotal.toFixed(0).padStart(6)} ${p.p10.toFixed(0).padStart(6)} ${p.p50.toFixed(0).padStart(6)} ${p.p90.toFixed(0).padStart(6)} ${p.meanGames.toFixed(1).padStart(6)}`,
    );
  }

  const actuals = data.get(season)?.summaries;

  if (actuals) {
    const pairs = projections
      .map((p) => {
        const actual = actuals.get(p.playerId);
        return actual
          ? { predicted: p.meanTotal, actual: actual.pointsPerGame * actual.games, p10: p.p10, p90: p.p90 }
          : undefined;
      })
      .filter((x): x is NonNullable<typeof x> => x !== undefined);

    const meanP = pairs.reduce((s, x) => s + x.predicted, 0) / pairs.length;
    const meanA = pairs.reduce((s, x) => s + x.actual, 0) / pairs.length;
    let cov = 0;
    let vp = 0;
    let va = 0;
    let inside = 0;

    for (const pair of pairs) {
      cov += (pair.predicted - meanP) * (pair.actual - meanA);
      vp += (pair.predicted - meanP) ** 2;
      va += (pair.actual - meanA) ** 2;

      if (pair.actual >= pair.p10 && pair.actual <= pair.p90) {
        inside++;
      }
    }

    console.log(
      `\nagainst what happened: correlation ${(cov / Math.sqrt(vp * va)).toFixed(3)} over ${pairs.length} players, ${((inside / pairs.length) * 100).toFixed(0)}% of totals inside the 80% band`,
    );

    const adp = await loadAdp(season).catch(() => undefined);

    if (adp) {
      const ppgOf = new Map(players.map((p) => [p.playerId, p.projectedPpg]));
      const matched = projections
        .map((p) => {
          const actual = actuals.get(p.playerId);
          const entry = adp.get(`${normalizeName(p.name)}|${p.position}`);
          return actual && entry
            ? {
                simTotal: p.meanTotal,
                ppg: ppgOf.get(p.playerId) ?? 0,
                adp: entry.adp,
                actualTotal: actual.pointsPerGame * actual.games,
              }
            : undefined;
        })
        .filter((x): x is NonNullable<typeof x> => x !== undefined);

      const score = (subset: typeof matched, label: string) => {
        const actual = subset.map((r) => r.actualTotal);
        console.log(`${label} (${subset.length} players):`);
        console.log(
          `  simulated total ${spearman(subset.map((r) => r.simTotal), actual).toFixed(3)}  projected ppg ${spearman(subset.map((r) => r.ppg), actual).toFixed(3)}  adp ${spearman(subset.map((r) => -r.adp), actual).toFixed(3)}`,
        );
      };

      console.log("\nranking actual season totals:");
      score(matched, "all matched to adp");
      score(
        [...matched].sort((a, b) => a.adp - b.adp).slice(0, 60),
        "top 60 by adp",
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

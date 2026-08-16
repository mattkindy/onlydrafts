import { loadGames, loadWeeklyRosters } from "../data/nflverse.js";
import { loadTendencies } from "../data/tendencies.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
  projectDraftExamples,
  type SeasonData,
  type SeasonExample,
} from "./seasonModel.js";
import { fitRookieModel, predictRookie, rookiesFor } from "./rookies.js";
import {
  weeklyExamplesForSeason,
  weeklyRow,
} from "./weeklyModel.js";
import type { WeeklyExample } from "./weekly.js";
import { fitRidge, predictRidge } from "../backtest/ridge.js";
import {
  buildSeasonNoise,
  type ResidualModel,
  type SeasonNoise,
} from "../backtest/intervals.js";
import { presets, fantasyPoints } from "../scoring/fantasyPoints.js";
import type { SeasonPlayer } from "../sim/playerSeason.js";
import type { GameRow } from "../data/nflverse.js";

/** everything the preseason simulators need, built from draft-day data */
export interface PreseasonWorld {
  season: number;
  games: GameRow[];
  data: Map<number, SeasonData>;
  players: SeasonPlayer[];
  playersById: Map<string, SeasonPlayer>;
  residuals: ResidualModel;
  seasonNoise: SeasonNoise;
  oppAdjust: (position: string, opponent: string) => number;
  catcherLoading: Map<string, number>;
  /** bye week per NFL team, for roster construction logic */
  byeWeek: Map<string, number>;
  /** the weekly kernel's weights, trained on seasons before this one */
  weeklyWeights: number[];
}

export async function buildPreseasonWorld(
  season: number,
): Promise<PreseasonWorld> {
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

  const summaries = data.get(season - 1)!.summaries;
  const players: SeasonPlayer[] = [];

  for (const e of board) {
    const team = teamOf.get(e.playerId);

    if (!team) {
      continue;
    }

    players.push({
      playerId: e.playerId,
      name: summaries.get(e.playerId)?.playerName ?? e.playerId,
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

  const byeWeek = new Map<string, number>();
  const teamsSeen = new Set(players.map((p) => p.teamId));

  for (const team of teamsSeen) {
    for (let w = 1; w <= 14; w++) {
      const plays = games.some(
        (g) =>
          g.season === season &&
          g.week === w &&
          (g.homeTeamId === team || g.awayTeamId === team),
      );

      if (!plays) {
        byeWeek.set(team, w);
        break;
      }
    }
  }

  return {
    season,
    games,
    data,
    players,
    playersById: new Map(players.map((p) => [p.playerId, p])),
    residuals: seasonNoise.within,
    seasonNoise,
    oppAdjust,
    catcherLoading,
    byeWeek,
    weeklyWeights,
  };
}

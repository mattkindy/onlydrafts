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
import { fantasyPoints } from "../scoring/fantasyPoints.js";
import { PART_NAMES, type StatParts } from "./seasonSummary.js";
import { scoring } from "../scoring/active.js";
import {
  fitPartsModel, predictParts, partsByPosition, blankParts,
} from "./partsModel.js";
import { fitAvailability, predictAvailability } from "./gamesPlayed.js";
import { readAvailability } from "./availabilityData.js";
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
  /** the same before it is pulled back toward level, which one week wants */
  oppIndex: (position: string, opponent: string) => number;
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
  /**
   * The same model again, part by part, so what it says can be scored
   * by any league rather than only the one this run was told about.
   */
  const partsFit = fitPartsModel(train);
  const partFloors = partsByPosition(train);
  const board = await projectDraftExamples(season, data);
  const rookieTrain = [];

  for (const t of seasons.filter((s) => s >= 2017 && s < season)) {
    rookieTrain.push(...(await rookiesFor(t, data, games)));
  }

  const rookieWeights = fitRookieModel(rookieTrain);
  const rookieClass = await rookiesFor(season, data, games);

  const bucketOf = (gamesPrev: number) =>
    gamesPrev >= 14 ? "durable" : gamesPrev >= 9 ? "spotty" : "thin";
  /**
   * How many games a man plays, from men like him last year.
   *
   * Rookies were one pool, and most rookies never play, so a first
   * round back came out at three games. Where he was drafted says
   * most of it, so they are split by that.
   */
  const rookieBucket = (overall: number) =>
    overall <= 64 ? "rookie-early"
      : overall <= 150 ? "rookie-middle"
      : "rookie-late";
  const gamesPools = new Map<string, number[]>([
    ["durable", []],
    ["spotty", []],
    ["thin", []],
    ["rookie-early", []],
    ["rookie-middle", []],
    ["rookie-late", []],
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
    gamesPools.get(rookieBucket(r.overall))!.push(r.actualGames);
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

    const points = fantasyPoints(row.statLine, scoring());
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

  /**
   * What a defence gave up at this position against what everybody
   * gave up, as a ratio. Around 0.7 for the best and 1.3 for the worst.
   */
  const oppIndex = (position: string, opponent: string): number => {
    const entry = allowed.get(`${opponent}|${position}`);
    const mean = leaguePerTeamGame.get(position);

    if (!entry || !mean || entry.games.size === 0) {
      return 1;
    }

    return entry.points / entry.games.size / mean;
  };

  /**
   * The same, pulled most of the way back toward level.
   *
   * Last season's numbers overstate how much of a defence carries
   * into the next one, and this scales a whole season's projection,
   * where a schedule of hard weeks and easy ones mostly cancels.
   */
  const oppAdjust = (position: string, opponent: string): number =>
    1 + 0.12 * (oppIndex(position, opponent) - 1);

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

  /**
   * How many games each man is likely to be available for.
   *
   * Four buckets of last season's games gave everyone in a bucket the
   * same answer. A fitted model reads his last three seasons, his age,
   * how much he was given, what the injury report said and whether he
   * finished the year on it, and lands 4.3 games out against the
   * buckets' 4.7, ordering them .58 against .48.
   */
  const availability = await readAvailability(
    seasons.filter((s) => s >= 2018 && s <= season),
  );
  const availabilityFit = fitAvailability(
    seasons.filter((s) => s >= 2018 && s < season)
      .flatMap((s) => availability.rowsFor(s)),
  );
  const expectedGames = new Map<string, number>();

  for (const row of availability.rowsFor(season)) {
    expectedGames.set(row.playerId, predictAvailability(availabilityFit, row));
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
      projectedParts: predictParts(partsFit, e, partFloors),
      gamesPool: gamesPools.get(bucketOf(e.gamesPrev))!,
      expectedGames: expectedGames.get(e.playerId),
    });
  }

  for (const r of rookieClass) {
    const team = teamOf.get(r.playerId);

    if (!team) {
      continue;
    }

    /**
     * A rookie in yards and catches, from what his position does,
     * scaled until it scores what the rookie model says he scores.
     *
     * Without this he shipped no parts at all, and a page that scores
     * the parts itself fell back to the played out games, which barely
     * know a man who has never taken a snap: Jeremiyah Love came out
     * at a third of a point a game where the model has him at thirteen.
     */
    const says = predictRookie(rookieWeights, r);
    const shape = partFloors.get(r.position) ?? blankParts();
    const worth = fantasyPoints(
      { ...shape, fumblesLost: 0, twoPointConversions: 0 }, scoring(),
    );
    const scale = worth > 0 ? says / worth : 0;

    players.push({
      playerId: r.playerId,
      name: r.name,
      position: r.position,
      teamId: team,
      projectedPpg: says,
      projectedParts: PART_NAMES.reduce((out: StatParts, part) => {
        out[part] = shape[part] * scale;

        return out;
      }, blankParts()),
      gamesPool: gamesPools.get(rookieBucket(r.overall))!,
      rookie: true,
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
    oppIndex,
    catcherLoading,
    byeWeek,
    weeklyWeights,
  };
}

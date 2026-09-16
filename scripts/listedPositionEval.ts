/**
 * Taking a player's position from the roster rather than his stat rows
 * puts players on the season board who were not there at all. Are they
 * better off there?
 *
 * Each of them is marked three ways against what he went on to average:
 * the season board, the draft slot prior the board used to hand him,
 * and his own points a game last season, which is what a person would
 * look up. Every fit is trained on seasons before the one predicted.
 *
 * Run: npx tsx scripts/listedPositionEval.ts
 */

import { loadGames } from "../src/data/nflverse.js";
import { isFantasyPosition } from "../src/data/listedPositions.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
  type SeasonData,
  type SeasonExample,
} from "../src/features/seasonModel.js";
import {
  fitRookieModel,
  predictRookie,
  rookiesFor,
} from "../src/features/rookies.js";

const FIRST_DATA = 2015;
const FIRST_TRANSITION = 2017;
const LAST_PLAYED = 2025;
const MARKED = [2019, 2020, 2021, 2022, 2023, 2024, 2025];

function seasons(from: number, to: number): number[] {
  const all: number[] = [];

  for (let s = from; s <= to; s++) {
    all.push(s);
  }

  return all;
}

function mae(said: number[], was: number[]): number {
  return said.reduce((s, p, i) => s + Math.abs(p - was[i]!), 0) / said.length;
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;
  let together = 0;
  let spreadA = 0;
  let spreadB = 0;

  for (let i = 0; i < n; i++) {
    together += (a[i]! - meanA) * (b[i]! - meanB);
    spreadA += (a[i]! - meanA) ** 2;
    spreadB += (b[i]! - meanB) ** 2;
  }

  return together / Math.sqrt(spreadA * spreadB);
}

interface Mark {
  season: number;
  name: string;
  position: string;
  filedAt: string;
  actual: number;
  board: number;
  lastSeason: number;
  /** the draft slot prior, where the board used to have one for him */
  rookiePrior?: number;
}

/** who the stat rows file away from where the roster has him playing */
function movedPositions(
  filed: SeasonData,
  listed: SeasonData,
): Map<string, string> {
  const moved = new Map<string, string>();

  for (const [playerId, was] of listed.summaries) {
    const before = filed.summaries.get(playerId);

    if (before && !isFantasyPosition(before.position) &&
      isFantasyPosition(was.position)) {
      moved.set(playerId, before.position);
    }
  }

  return moved;
}

async function main(): Promise<void> {
  const years = seasons(FIRST_DATA, LAST_PLAYED);
  const listed = await buildSeasonData(years);
  const filed = await buildSeasonData(years, { fromStatRowsOnly: true });
  const games = await loadGames();
  const examples = new Map<number, SeasonExample[]>();

  for (const year of seasons(FIRST_TRANSITION, LAST_PLAYED)) {
    examples.set(year, await examplesForTransition(year, listed));
  }

  const marks: Mark[] = [];

  for (const season of MARKED) {
    const train: SeasonExample[] = [];
    const rookieTrain = [];

    for (const year of seasons(FIRST_TRANSITION, season - 1)) {
      train.push(...examples.get(year)!);
      rookieTrain.push(...(await rookiesFor(year, filed, games)));
    }

    const fit = fitSeasonModel(train);
    const rookieWeights = fitRookieModel(rookieTrain);
    // the board reaches for this list when the stat rows leave it with
    // no season of a player to read
    const unread = new Map(
      (await rookiesFor(season, filed, games, { alsoUnread: true }))
        .map((r) => [r.playerId, r]),
    );
    const moved = movedPositions(filed.get(season - 1)!, listed.get(season - 1)!);
    let found = 0;

    for (const e of examples.get(season)!) {
      const filedAt = moved.get(e.playerId);

      if (!filedAt) {
        continue;
      }

      found++;
      const prior = unread.get(e.playerId);
      marks.push({
        season,
        name: listed.get(season - 1)!.summaries.get(e.playerId)!.playerName,
        position: e.position,
        filedAt,
        actual: e.actualPpg,
        board: predictSeasonBlend(fit, e),
        lastSeason: e.prevPpg,
        rookiePrior:
          prior === undefined ? undefined : predictRookie(rookieWeights, prior),
      });
    }

    console.log(
      `${season}: ${moved.size} players filed elsewhere last season, ` +
      `${found} of them now on the board`,
    );
  }

  const say = (label: string, kept: Mark[], said: (m: Mark) => number) => {
    const was = kept.map((m) => m.actual);
    const now = kept.map(said);

    console.log(
      `${label.padEnd(24)}${mae(now, was).toFixed(3)}  ` +
      `${correlation(now, was).toFixed(3)}`,
    );
  };

  console.log(`\n${marks.length} player seasons put back on the board`);
  console.log("".padEnd(24) + "MAE    corr");
  say("season board", marks, (m) => m.board);
  say("his own last season", marks, (m) => m.lastSeason);
  say("oracle", marks, (m) => m.actual);

  const withPrior = marks.filter((m) => m.rookiePrior !== undefined);
  console.log(
    `\n${withPrior.length} of them had a draft slot prior before this change`,
  );

  if (withPrior.length > 1) {
    console.log("".padEnd(24) + "MAE    corr");
    say("season board", withPrior, (m) => m.board);
    say("draft slot prior", withPrior, (m) => m.rookiePrior!);
    say("his own last season", withPrior, (m) => m.lastSeason);
  }

  console.log("\nevery one of them, worst miss first");
  const worst = [...marks].sort(
    (a, b) => Math.abs(b.board - b.actual) - Math.abs(a.board - a.actual),
  );

  for (const m of worst) {
    const prior =
      m.rookiePrior === undefined ? "none" : m.rookiePrior.toFixed(1);
    console.log(
      `  ${m.season} ${m.name.padEnd(20)} ${m.filedAt}->${m.position}  ` +
      `board ${m.board.toFixed(1)}  prior ${prior}  ` +
      `last season ${m.lastSeason.toFixed(1)}  actual ${m.actual.toFixed(1)}`,
    );
  }
}

await main();

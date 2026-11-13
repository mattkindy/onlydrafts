/**
 * How well the kicker model predicts a kicker's points a game over a
 * season, against the two guesses a drafter could make for free.
 *
 * Every season is predicted from the one before it and nothing here
 * reads the season being predicted. The rivals are the kicker's own
 * points a game last season and the league's average kicker, and the
 * ceiling is an oracle that knew the answer.
 *
 * It also prints how many games the kickers who started a season went
 * on to play, since the board hands every one of them the same 15.3.
 *
 * With `--rest` it asks the in-season question instead: standing at week
 * 4, 6, 8 or 10, what a kicker goes on to score a game over the rest of
 * the season, read off the model's preseason number, what he has scored
 * so far, and the average kicker. That is the number a waiver pickup is
 * priced by, and it says how far one kicker's number can be trusted over
 * another's.
 *
 * Run: npx tsx scripts/kickerSeasonEval.ts [--seasons 2024,2025] [--rest]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadKickerWeeks, type KickerWeek } from "../src/data/nflverse.js";
import {
  addUp, historyOf, kickerJobs, kickerRosterSpots, recordsFrom,
  type KickerJob,
} from "../src/features/kickerJobs.js";
import { kickerSeason, type Fixture } from "../src/features/kickerSeason.js";
import { fitClimate } from "../src/features/climate.js";
import { kickoffsIn, readingsFrom } from "../src/data/gameWeather.js";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";

/**
 * A middle of the road kicker ladder: three for a short one, four from
 * forty, five from fifty, a point an extra point and a point off a
 * miss. Yardage is not paid, because most leagues do not pay it and
 * paying it makes every comparison here about field position.
 */
const KICK_PAYS: Record<string, number> = {
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4,
  fgm_50_59: 5, fgm_60p: 5,
  fgmiss_0_19: -1, fgmiss_20_29: -1, fgmiss_30_39: -1, fgmiss_40_49: -1,
  fgmiss_50_59: 0, fgmiss_60p: 0,
  xpm: 1, xpmiss: -1,
};

const pay = (parts: Record<string, number>) =>
  Object.entries(KICK_PAYS).reduce(
    (sum, [part, rate]) => sum + (parts[part] ?? 0) * rate, 0);

/** what the board gives every kicker today */
const FLAT_GAMES = 15.3;

/** how many games of a kicker's own before he is worth reading at all */
const ENOUGH_GAMES = 6;

const RAW = join(import.meta.dirname, "..", "data", "raw");
const KEPT = join(import.meta.dirname, "..", "data", "kept");

interface Walk {
  runs?: number;
  weeks?: number;
  kicks?: [string, { from: number[]; conversions: number }][];
}

async function walkFor(season: number): Promise<Walk> {
  const text = await readFile(join(KEPT, `played-${season}.json`), "utf8")
    .catch(() => "");

  return text ? JSON.parse(text) as Walk : {};
}

/** where and when each club plays, so a kicker's weeks get their grounds */
function fixturesFor(
  rows: Record<string, string>[], season: number,
): Map<string, Fixture[]> {
  const out = new Map<string, Fixture[]>();

  for (const k of kickoffsIn(rows, season)) {
    for (const team of [k.homeTeam, k.awayTeam]) {
      out.set(team, [
        ...(out.get(team) ?? []),
        { week: k.week, host: k.homeTeam, hour: k.hour },
      ]);
    }
  }

  return out;
}

interface Guess {
  name: string;
  team: string;
  model: number | null;
  lastYear: number;
  actual: number;
  playedGames: number;
}

/** the model's points a game for one kicker, or nothing where it is blind */
function modelSays(
  job: KickerJob, walk: Walk, fixtures: Fixture[],
  climate: ReturnType<typeof fitClimate>,
): number | null {
  const its = new Map(walk.kicks ?? []).get(job.team);

  if (!its) {
    return null;
  }

  const runs = walk.runs ?? 40;
  const played = kickerSeason(
    historyOf(job.record),
    its.from.map((yardline) => yardline + 17),
    its.conversions * runs,
    (walk.weeks ?? 17) * runs,
    FLAT_GAMES,
    2000,
    seededRng(29),
    [...fixtures].sort((a, b) => a.week - b.week),
    climate,
  );

  return pay(played.parts);
}

function errors(pairs: [number, number][]): { mae: number; corr: number } {
  if (pairs.length === 0) {
    return { mae: 0, corr: 0 };
  }

  const mae = pairs.reduce((s, [said, was]) => s + Math.abs(said - was), 0) /
    pairs.length;
  const mean = (at: 0 | 1) =>
    pairs.reduce((s, p) => s + p[at], 0) / pairs.length;
  const [mx, my] = [mean(0), mean(1)];
  let top = 0;
  let leftSq = 0;
  let rightSq = 0;

  for (const [said, was] of pairs) {
    top += (said - mx) * (was - my);
    leftSq += (said - mx) ** 2;
    rightSq += (was - my) ** 2;
  }

  const under = Math.sqrt(leftSq * rightSq);

  return { mae, corr: under > 0 ? top / under : 0 };
}

/**
 * The most a model of a kicker's season could manage, read off the
 * season itself: his first half against his second, which is the same
 * player with the same job and no year in between.
 */
function splitHalf(weeks: KickerWeek[]): [number, number][] {
  const byPlayer = new Map<string, KickerWeek[]>();

  for (const week of weeks) {
    byPlayer.set(week.playerId, [...(byPlayer.get(week.playerId) ?? []), week]);
  }

  const pairs: [number, number][] = [];

  for (const his of byPlayer.values()) {
    const sorted = [...his].sort((a, b) => a.week - b.week);

    if (sorted.length < 12) {
      continue;
    }

    const cut = Math.floor(sorted.length / 2);
    const half = (part: KickerWeek[]) => pay(addUp(part)) / part.length;
    pairs.push([half(sorted.slice(0, cut)), half(sorted.slice(cut))]);
  }

  return pairs;
}

async function jobsFor(season: number): Promise<Map<string, KickerJob>> {
  return kickerJobs({
    lastSeason: await loadKickerWeeks(season - 1),
    soFar: [],
    onRoster: await kickerRosterSpots(season),
  });
}

async function guessesFor(season: number): Promise<Guess[]> {
  const jobs = await jobsFor(season);
  const actual = recordsFrom(await loadKickerWeeks(season));
  const walk = await walkFor(season);
  const gameRows = parseCsv(await readFile(join(RAW, "games.csv"), "utf8"));
  const climate = fitClimate(readingsFrom(gameRows));
  const where = fixturesFor(gameRows, season);
  const out: Guess[] = [];

  for (const job of jobs.values()) {
    const was = actual.get(job.record.playerId);

    if (!was || was.games < ENOUGH_GAMES) {
      continue;
    }

    out.push({
      name: job.record.name,
      team: job.team,
      model: modelSays(job, walk, where.get(job.team) ?? [], climate),
      lastYear: pay(job.record.parts) / job.record.games,
      actual: pay(was.parts) / was.games,
      playedGames: was.games,
    });
  }

  return out;
}

interface Season {
  /** how accurate he was last season, which is what a club watches */
  makeRate: number;
  /** and how much he had kicked, since a part season says less */
  lastGames: number;
  games: number;
}

/** how many games the kickers who held a job in the spring went on to play */
async function gamesPlayed(season: number): Promise<Season[]> {
  const jobs = await jobsFor(season);
  const actual = recordsFrom(await loadKickerWeeks(season));

  return [...jobs.values()].map((job) => {
    const at = (part: string) => job.record.parts[part] ?? 0;
    const taken = at("fgm") + at("fgmiss");

    return {
      makeRate: taken > 0 ? at("fgm") / taken : 0,
      lastGames: job.record.games,
      games: actual.get(job.record.playerId)?.games ?? 0,
    };
  });
}

/** whether last season's accuracy says anything about keeping the job */
function sayByAccuracy(seasons: Season[]): void {
  const sorted = [...seasons].sort((a, b) => a.makeRate - b.makeRate);
  const third = Math.floor(sorted.length / 3);
  const bands: [string, Season[]][] = [
    ["least accurate third", sorted.slice(0, third)],
    ["middle third", sorted.slice(third, third * 2)],
    ["most accurate third", sorted.slice(third * 2)],
  ];

  for (const [what, his] of bands) {
    const mean = his.reduce((s, n) => s + n.games, 0) / Math.max(1, his.length);
    const lost = his.filter((n) => n.games < 12).length;
    console.log(
      `  ${what.padEnd(22)} made ` +
      `${(his.reduce((s, n) => s + n.makeRate, 0) / his.length * 100).toFixed(0)}%, ` +
      `played ${mean.toFixed(1)} games, ${lost} of ${his.length} under twelve`,
    );
  }
}

function sayTable(covered: Guess[], poolMean: number): void {
  const rows: [string, [number, number][]][] = [
    ["the model", covered.map((g) => [g.model!, g.actual])],
    ["last season, his own", covered.map((g) => [g.lastYear, g.actual])],
    ["the mean kicker", covered.map((g) => [poolMean, g.actual])],
    ["an oracle", covered.map((g) => [g.actual, g.actual])],
  ];

  console.log("method                     MAE    corr    bias   spread");

  for (const [what, pairs] of rows) {
    const { mae, corr } = errors(pairs);
    const said = pairs.map(([n]) => n);
    const mean = said.reduce((s, n) => s + n, 0) / said.length;
    const was = pairs.reduce((s, [, n]) => s + n, 0) / pairs.length;
    const spread = Math.sqrt(
      said.reduce((s, n) => s + (n - mean) ** 2, 0) / said.length);
    console.log(
      `${what.padEnd(24)} ${mae.toFixed(2).padStart(5)}  ` +
      `${corr.toFixed(3).padStart(6)}  ${(mean - was).toFixed(2).padStart(5)}  ` +
      `${spread.toFixed(2).padStart(5)}`,
    );
  }
}

/** the weeks a season is cut at for the rest of season question */
const CUTS = [4, 6, 8, 10];
/** games before the cut, and after it, before a kicker is counted */
const BEFORE_GAMES = 2;
const AFTER_GAMES = 3;

interface RestRow {
  season: number;
  cut: number;
  name: string;
  model: number;
  soFar: number;
  rest: number;
}

async function restRowsFor(season: number): Promise<RestRow[]> {
  const jobs = await jobsFor(season);
  const weeks = await loadKickerWeeks(season);
  const walk = await walkFor(season);
  const gameRows = parseCsv(await readFile(join(RAW, "games.csv"), "utf8"));
  const climate = fitClimate(readingsFrom(gameRows));
  const where = fixturesFor(gameRows, season);
  const out: RestRow[] = [];

  for (const job of jobs.values()) {
    const model = modelSays(job, walk, where.get(job.team) ?? [], climate);

    if (model === null) {
      continue;
    }

    const his = weeks.filter((w) => w.playerId === job.record.playerId);

    for (const cut of CUTS) {
      const before = his.filter((w) => w.week <= cut);
      const after = his.filter((w) => w.week > cut);

      if (before.length < BEFORE_GAMES || after.length < AFTER_GAMES) {
        continue;
      }

      out.push({
        season, cut, name: job.record.name, model,
        soFar: pay(addUp(before)) / before.length,
        rest: pay(addUp(after)) / after.length,
      });
    }
  }

  return out;
}

/**
 * Each reader as a move off the cut's average kicker, so a weight learnt
 * under one ladder means the same under another: what a kicker goes on
 * to score over the average, against how far the model and his season so
 * far each have him over theirs.
 */
function centred(rows: RestRow[]): (RestRow & { dm: number; ds: number; dr: number; m0: number })[] {
  const out: (RestRow & { dm: number; ds: number; dr: number; m0: number })[] = [];

  for (const season of new Set(rows.map((r) => r.season))) {
    for (const cut of CUTS) {
      const at = rows.filter((r) => r.season === season && r.cut === cut);
      const avg = (f: (r: RestRow) => number) =>
        at.reduce((sum, r) => sum + f(r), 0) / Math.max(1, at.length);
      const [mm, ms] = [avg((r) => r.model), avg((r) => r.soFar)];

      for (const r of at) {
        // the average a kicker has scored so far is the level a guess is
        // made from; what he goes on to do is read against it
        out.push({ ...r, dm: r.model - mm, ds: r.soFar - ms, dr: r.rest - ms, m0: ms });
      }
    }
  }

  return out;
}

/** least squares through the origin on the two moves */
function fitMoves(rows: { dm: number; ds: number; dr: number }[]): [number, number] {
  let mm = 0, ss = 0, ms = 0, mr = 0, sr = 0;

  for (const r of rows) {
    mm += r.dm * r.dm; ss += r.ds * r.ds; ms += r.dm * r.ds;
    mr += r.dm * r.dr; sr += r.ds * r.dr;
  }

  const det = mm * ss - ms * ms;

  return det > 0 ? [(mr * ss - sr * ms) / det, (sr * mm - mr * ms) / det] : [0, 0];
}

function fitOne(rows: { x: number; dr: number }[]): number {
  const top = rows.reduce((s, r) => s + r.x * r.dr, 0);
  const under = rows.reduce((s, r) => s + r.x * r.x, 0);

  return under > 0 ? top / under : 0;
}

async function rest(seasons: number[]): Promise<void> {
  const rows: RestRow[] = [];

  for (const season of seasons) {
    const his = await restRowsFor(season);
    console.log(`${season}: ${his.length} kicker cuts`);
    rows.push(...his);
  }

  const all = centred(rows);
  const said = new Map<string, [number, number][]>();
  const add = (what: string, pair: [number, number]) =>
    said.set(what, [...(said.get(what) ?? []), pair]);

  // each season read by weights the other seasons learnt
  for (const season of seasons) {
    const train = all.filter((r) => r.season !== season);
    const [wm, ws] = fitMoves(train);
    const onlyModel = fitOne(train.map((r) => ({ x: r.dm, dr: r.dr })));
    const onlySoFar = fitOne(train.map((r) => ({ x: r.ds, dr: r.dr })));

    for (const r of all.filter((x) => x.season === season)) {
      add("the average kicker", [r.m0, r.rest]);
      add("the model, as it is", [r.m0 + r.dm, r.rest]);
      add("his season so far", [r.soFar, r.rest]);
      add("the model, shrunk", [r.m0 + onlyModel * r.dm, r.rest]);
      add("his season so far, shrunk", [r.m0 + onlySoFar * r.ds, r.rest]);
      add("both, shrunk", [r.m0 + wm * r.dm + ws * r.ds, r.rest]);
      add("an oracle", [r.rest, r.rest]);
    }
  }

  const [wm, ws] = fitMoves(all);
  console.log(`
${all.length} kicker cuts at weeks ${CUTS.join(", ")}; ` +
    `fitted on every season, a point over the average on the model is worth ` +
    `${wm.toFixed(2)} and a point on his season so far ${ws.toFixed(2)}; ` +
    `alone, the model ${fitOne(all.map((r) => ({ x: r.dm, dr: r.dr }))).toFixed(2)} ` +
    `and his season so far ${fitOne(all.map((r) => ({ x: r.ds, dr: r.dr }))).toFixed(2)}\n`);
  console.log("each season held out    MAE    corr   spread");

  for (const [what, pairs] of said) {
    const { mae, corr } = errors(pairs);
    const xs = pairs.map(([n]) => n);
    const mean = xs.reduce((s, n) => s + n, 0) / xs.length;
    const spread = Math.sqrt(xs.reduce((s, n) => s + (n - mean) ** 2, 0) / xs.length);
    console.log(`${what.padEnd(24)} ${mae.toFixed(2).padStart(5)}  ` +
      `${corr.toFixed(3).padStart(6)}  ${spread.toFixed(2).padStart(5)}`);
  }

  const restSpread = (() => {
    const xs = all.map((r) => r.dr);
    const m = xs.reduce((s, n) => s + n, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, n) => s + (n - m) ** 2, 0) / xs.length);
  })();
  console.log(`
what kickers went on to score spreads ${restSpread.toFixed(2)} a game around the average`);
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = flag === -1
    ? [2023, 2024, 2025]
    : process.argv[flag + 1]!.split(",").map(Number);

  if (process.argv.includes("--rest")) {
    await rest(seasons);
    return;
  }

  const guesses: Guess[] = [];
  const halves: [number, number][] = [];
  const games: Season[] = [];

  for (const season of seasons) {
    const his = await guessesFor(season);
    console.log(`${season}: ${his.length} kickers with a job and a season`);
    guesses.push(...his);
    halves.push(...splitHalf(await loadKickerWeeks(season)));
    games.push(...await gamesPlayed(season));
  }

  const covered = guesses.filter((g) => g.model !== null);
  const poolMean = guesses.reduce((s, g) => s + g.lastYear, 0) / guesses.length;

  console.log(`\n${covered.length} kicker seasons, ` +
    `points a game averaging ${poolMean.toFixed(2)}\n`);
  sayTable(covered, poolMean);

  const half = errors(halves);
  console.log(
    `\nhalf a season against the other half: MAE ${half.mae.toFixed(2)}, ` +
    `corr ${half.corr.toFixed(3)} over ${halves.length} seasons`,
  );

  const sorted = [...games].map((n) => n.games).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(q * sorted.length)] ?? 0;
  const mean = sorted.reduce((s, n) => s + n, 0) / Math.max(1, sorted.length);
  console.log(
    `\ngames played by the ${games.length} kickers who held a job in the ` +
    `spring: mean ${mean.toFixed(1)}, median ${at(0.5)}, a quarter play ` +
    `${at(0.25)} or fewer, a tenth ${at(0.1)} or fewer. The board gives ` +
    `every one ${FLAT_GAMES}.`,
  );
  sayByAccuracy(games);

  const worst = [...covered]
    .sort((a, b) =>
      Math.abs(b.model! - b.actual) - Math.abs(a.model! - a.actual))
    .slice(0, 10);
  console.log("\nthe ten the model was furthest out on");

  for (const g of worst) {
    console.log(
      `  ${g.name.padEnd(20)} ${g.team.padEnd(4)} model ` +
      `${g.model!.toFixed(1).padStart(5)}, last year ` +
      `${g.lastYear.toFixed(1).padStart(5)}, was ` +
      `${g.actual.toFixed(1).padStart(5)} over ${g.playedGames} games`,
    );
  }
}

void main();

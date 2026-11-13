/**
 * Whether a kicker's misses this season say anything about the rest of it.
 *
 * The board reads a kicker's accuracy off last season alone and hands the
 * club's job to whoever kicked for it last, so a kicker who has missed
 * eight this season reads exactly as he did in the spring until somebody
 * else takes a kick for his club. This asks the two questions that
 * leaves open, standing at week 4, 6, 8 or 10 of every season from 2016:
 *
 * - does his accuracy so far carry into the rest of the season, once the
 *   distances he was sent out from are allowed for, and
 * - does it say whether he keeps the job, which a manager pays for in
 *   full: a kicker who is cut scores nothing for the side that holds him.
 *
 * Accuracy is read as makes over expected: each attempt against what
 * every kicker makes from that band, so a kicker sent out from 55 three
 * times is not marked down for missing one.
 *
 * With `--walk` it scores the walk's own number for the same cuts over
 * 2023 to 2025, the seasons with a walk on disk: as the board has it,
 * with this season's kicks folded into his accuracy, and with the
 * chance he keeps the job taken off, each season held out of the fit.
 *
 * Run: npx tsx scripts/kickerMissesEval.ts [--seasons 2016-2025] [--walk]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames, loadKickerWeeks, type KickerWeek } from "../src/data/nflverse.js";
import { BANDS } from "../src/features/kickerFromWalk.js";
import { addUp, historyOf, type KickerRecord } from "../src/features/kickerJobs.js";
import { kickerSeason, type Fixture } from "../src/features/kickerSeason.js";
import { fitClimate } from "../src/features/climate.js";
import { kickoffsIn, readingsFrom } from "../src/data/gameWeather.js";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";

/** what everyone makes from each band, the same table the walk reads */
const LEAGUE_MAKES = [0.98, 0.97, 0.94, 0.85, 0.68, 0.4];

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

const CUTS = [4, 6, 8, 10];
/** games of his own this season before a cut reads him */
const BEFORE_GAMES = 3;

interface Kicking {
  attempts: number;
  made: number;
  /** what an average kicker makes from the same attempts */
  expected: number;
  xpAttempts: number;
  xpMade: number;
  points: number;
  games: number;
}

function kickingOf(weeks: KickerWeek[]): Kicking {
  const out: Kicking = {
    attempts: 0, made: 0, expected: 0, xpAttempts: 0, xpMade: 0,
    points: 0, games: weeks.length,
  };

  for (const w of weeks) {
    BANDS.forEach((band, i) => {
      const made = w.parts[`fgm_${band.name}`] ?? 0;
      const missed = w.parts[`fgmiss_${band.name}`] ?? 0;
      out.attempts += made + missed;
      out.made += made;
      out.expected += (made + missed) * LEAGUE_MAKES[i]!;
    });
    out.xpMade += w.parts["xpm"] ?? 0;
    out.xpAttempts += (w.parts["xpm"] ?? 0) + (w.parts["xpmiss"] ?? 0);
    out.points += pay(w.parts);
  }

  return out;
}

/** makes over expected, a field goal at a time */
const overExpected = (k: Kicking) => k.made - k.expected;

interface Cut {
  season: number;
  playerId: string;
  before: KickerWeek[];
  lastWeeks: KickerWeek[];
  cut: number;
  name: string;
  team: string;
  so: Kicking;
  last: Kicking | null;
  /** his kicking after the cut, for whichever club */
  after: Kicking;
  /** the club's games after the cut, and how many of them he kicked in */
  clubGames: number;
  keptGames: number;
  /** what he scored for whoever held him, over the club's games left */
  pointsPerClubGame: number;
}

async function cutsFor(season: number): Promise<Cut[]> {
  const weeks = await loadKickerWeeks(season);
  const lastSeason = await loadKickerWeeks(season - 1);
  const games = (await loadGames()).filter((g) => g.season === season);
  const out: Cut[] = [];

  for (const cut of CUTS) {
    // the club's kicker at the cut: whoever kicked for it last
    const holder = new Map<string, KickerWeek>();

    for (const w of weeks.filter((x) => x.week <= cut)) {
      const already = holder.get(w.teamId);

      if (!already || w.week > already.week) {
        holder.set(w.teamId, w);
      }
    }

    for (const [team, last] of holder) {
      const his = weeks.filter((w) => w.playerId === last.playerId);
      const before = his.filter((w) => w.week <= cut);

      if (before.length < BEFORE_GAMES) {
        continue;
      }

      const clubWeeks = games
        .filter((g) => g.week > cut && (g.homeTeamId === team || g.awayTeamId === team))
        .map((g) => g.week);
      const afterHis = his.filter((w) => w.week > cut);
      const kept = afterHis.filter((w) => w.teamId === team && clubWeeks.includes(w.week));

      if (clubWeeks.length === 0) {
        continue;
      }

      const lastHis = lastSeason.filter((w) => w.playerId === last.playerId);

      out.push({
        season, cut, name: last.name, team, playerId: last.playerId,
        before, lastWeeks: lastHis,
        so: kickingOf(before),
        last: lastHis.length > 0 ? kickingOf(lastHis) : null,
        after: kickingOf(afterHis),
        clubGames: clubWeeks.length,
        keptGames: kept.length,
        pointsPerClubGame: kickingOf(kept).points / clubWeeks.length,
      });
    }
  }

  return out;
}

function corr(xs: number[], ys: number[], ws?: number[]): number {
  const w = ws ?? xs.map(() => 1);
  const total = w.reduce((s, n) => s + n, 0);
  const mx = xs.reduce((s, x, i) => s + x * w[i]!, 0) / total;
  const my = ys.reduce((s, y, i) => s + y * w[i]!, 0) / total;
  let top = 0, lx = 0, ly = 0;

  xs.forEach((x, i) => {
    top += w[i]! * (x - mx) * (ys[i]! - my);
    lx += w[i]! * (x - mx) ** 2;
    ly += w[i]! * (ys[i]! - my) ** 2;
  });

  return lx > 0 && ly > 0 ? top / Math.sqrt(lx * ly) : 0;
}

const mean = (xs: number[]) => xs.reduce((s, n) => s + n, 0) / Math.max(1, xs.length);
const f = (n: number, d = 2) => n.toFixed(d);

function seasonsFrom(argv: string[]): number[] {
  const flag = argv.indexOf("--seasons");
  const said = flag === -1 ? "2016-2025" : argv[flag + 1]!;
  const [from, to] = said.split("-").map(Number);

  return to
    ? Array.from({ length: to - from! + 1 }, (_, i) => from! + i)
    : said.split(",").map(Number);
}

/** a logistic fit of the share of the club's games he kicks on one reading */
function fitKeep(cuts: Cut[]): ((moe: number) => number) & { a: number; b: number } {
  let a = 2, b = 0.3;

  for (let step = 0; step < 4000; step++) {
    let ga = 0, gb = 0, n = 0;

    for (const c of cuts) {
      const x = overExpected(c.so);
      const p = 1 / (1 + Math.exp(-(a + b * x)));
      const y = c.keptGames / c.clubGames;
      ga += (y - p) * c.clubGames;
      gb += (y - p) * x * c.clubGames;
      n += c.clubGames;
    }

    a += 0.5 * ga / n;
    b += 0.5 * gb / n;
  }

  return Object.assign((moe: number) => 1 / (1 + Math.exp(-(a + b * moe))), { a, b });
}

interface Walk {
  runs?: number;
  weeks?: number;
  kicks?: [string, { from: number[]; conversions: number }][];
}

const recordOf = (playerId: string, weeks: KickerWeek[]): KickerRecord => ({
  playerId, name: weeks[0]?.name ?? "", team: weeks.at(-1)?.teamId ?? "",
  games: weeks.length, parts: addUp(weeks),
});

/** the walk's points a game for him from the club's kicks, after the cut */
function walkSays(
  record: KickerRecord, team: string, walk: Walk, fixtures: Fixture[],
  climate: ReturnType<typeof fitClimate>,
): number | null {
  const its = new Map(walk.kicks ?? []).get(team);

  if (!its) {
    return null;
  }

  const runs = walk.runs ?? 40;
  const played = kickerSeason(
    historyOf(record),
    its.from.map((yardline) => yardline + 17),
    its.conversions * runs,
    (walk.weeks ?? 17) * runs,
    fixtures.length,
    1000,
    seededRng(29),
    fixtures,
    climate,
  );

  return pay(played.parts);
}

async function withWalk(): Promise<void> {
  const seasons = [2023, 2024, 2025];
  const gameRows = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
  const climate = fitClimate(readingsFrom(gameRows));
  const rows: (Cut & { asIs: number; folded: number })[] = [];

  for (const season of seasons) {
    const walk = JSON.parse(await readFile(join(import.meta.dirname, "..", "data", "kept",
      `played-${season}.json`), "utf8")) as Walk;
    const where = new Map<string, Fixture[]>();

    for (const k of kickoffsIn(gameRows, season)) {
      for (const team of [k.homeTeam, k.awayTeam]) {
        where.set(team, [...(where.get(team) ?? []),
          { week: k.week, host: k.homeTeam, hour: k.hour }]);
      }
    }

    for (const c of await cutsFor(season)) {
      const left = (where.get(c.team) ?? [])
        .filter((x) => x.week > c.cut).sort((a, b) => a.week - b.week);

      if (c.lastWeeks.length === 0 || left.length === 0) {
        continue;
      }

      const asIs = walkSays(recordOf(c.playerId, c.lastWeeks), c.team, walk, left, climate);
      const folded = walkSays(
        recordOf(c.playerId, [...c.lastWeeks, ...c.before]), c.team, walk, left, climate);

      if (asIs !== null && folded !== null) {
        rows.push({ ...c, asIs, folded });
      }
    }
  }

  console.log(`${rows.length} kicker cuts over 2023-2025 with a walk and a season behind him\n`);

  const said = new Map<string, [number, number][]>();
  const add = (what: string, pair: [number, number]) =>
    said.set(what, [...(said.get(what) ?? []), pair]);
  // the history study's cuts, for fitting the keep chance on every other season
  const history: Cut[] = [];

  for (let season = 2016; season <= 2025; season++) {
    history.push(...await cutsFor(season));
  }

  for (const season of seasons) {
    const train = history.filter((c) => c.season !== season);
    const keep = fitKeep(train);
    const flat = train.reduce((s, c) => s + c.keptGames, 0) /
      train.reduce((s, c) => s + c.clubGames, 0);
    // the walk's level runs above life, so each reading is set to the
    // level of the cuts it is learnt on before it is scored
    const trainRows = rows.filter((r) => r.season !== season);
    const level = (f: (r: typeof rows[number]) => number) =>
      mean(trainRows.map((r) => r.pointsPerClubGame)) / mean(trainRows.map(f));
    const soFar = (r: Cut) => r.so.points / r.so.games;
    const readers: [string, (r: typeof rows[number]) => number][] = [
      ["the average kicker", () => 1],
      ["his season so far", soFar],
      ["the walk as the board has it", (r) => r.asIs * flat],
      ["with this season's kicks in his accuracy", (r) => r.folded * flat],
      ["as it is, with the job at risk", (r) => r.asIs * keep(overExpected(r.so))],
      ["with both", (r) => r.folded * keep(overExpected(r.so))],
    ];

    for (const [what, f] of readers) {
      const scale = level(f);

      for (const r of rows.filter((x) => x.season === season)) {
        add(what, [f(r) * scale, r.pointsPerClubGame]);
      }
    }
  }

  console.log("each season held out                         MAE    corr");

  for (const [what, pairs] of said) {
    const mae = mean(pairs.map(([a, b]) => Math.abs(a - b)));
    console.log(`${what.padEnd(44)} ${f(mae).padStart(5)}  ` +
      `${f(corr(pairs.map((p) => p[0]), pairs.map((p) => p[1])), 3).padStart(6)}`);
  }

  const keep = fitKeep(history);
  console.log(`\nfitted on 2016-2025, the share of the club's games he goes on to kick ` +
    `(logit ${f(keep.a, 3)} + ${f(keep.b, 3)} a kick):`);

  for (const moe of [-4, -3, -2, -1, 0, 1, 2]) {
    console.log(`  ${String(moe).padStart(2)} kicks against expected so far  ${f(keep(moe) * 100, 0)}%`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--walk")) {
    await withWalk();
    return;
  }

  const seasons = seasonsFrom(process.argv);
  const cuts: Cut[] = [];

  for (const season of seasons) {
    cuts.push(...await cutsFor(season));
  }

  console.log(`${cuts.length} kicker cuts over ${seasons[0]}-${seasons.at(-1)}, ` +
    `at weeks ${CUTS.join(", ")}\n`);

  // 1. does accuracy carry? per attempt, weighted by attempts after
  const carried = cuts.filter((c) => c.after.attempts >= 5 && c.so.attempts >= 5);
  const rate = (k: Kicking) => overExpected(k) / Math.max(1, k.attempts);
  console.log(`accuracy over expected, per attempt, so far against after: ` +
    `corr ${f(corr(carried.map((c) => rate(c.so)), carried.map((c) => rate(c.after)),
      carried.map((c) => c.after.attempts)), 3)} over ${carried.length} cuts`);

  const withLast = carried.filter((c) => c.last && c.last.attempts >= 10);
  console.log(`last season against after:                              ` +
    `corr ${f(corr(withLast.map((c) => rate(c.last!)), withLast.map((c) => rate(c.after)),
      withLast.map((c) => c.after.attempts)), 3)} over ${withLast.length}`);
  console.log(`so far against after, the same cuts:                     ` +
    `corr ${f(corr(withLast.map((c) => rate(c.so)), withLast.map((c) => rate(c.after)),
      withLast.map((c) => c.after.attempts)), 3)}`);
  console.log(`so far and last season pooled against after:             ` +
    `corr ${f(corr(
      withLast.map((c) => (overExpected(c.so) + overExpected(c.last!)) /
        (c.so.attempts + c.last!.attempts)),
      withLast.map((c) => rate(c.after)), withLast.map((c) => c.after.attempts)), 3)}\n`);

  // 2. by makes over expected so far, in kicks
  const groups: [string, (n: number) => boolean][] = [
    ["3 or more under", (n) => n <= -3],
    ["2 to 3 under", (n) => n > -3 && n <= -2],
    ["1 to 2 under", (n) => n > -2 && n <= -1],
    ["within 1", (n) => n > -1 && n < 1],
    ["1 or more over", (n) => n >= 1],
  ];

  console.log("makes over expected so far   cuts   made so far   " +
    "after: made  vs expected   kept the job   pts/club game   pts/game so far");

  for (const [what, inIt] of groups) {
    const them = cuts.filter((c) => inIt(overExpected(c.so)));
    const after = them.reduce((s, c) => ({
      made: s.made + c.after.made, att: s.att + c.after.attempts, exp: s.exp + c.after.expected,
    }), { made: 0, att: 0, exp: 0 });
    const so = them.reduce((s, c) => ({ made: s.made + c.so.made, att: s.att + c.so.attempts }),
      { made: 0, att: 0 });
    const kept = them.reduce((s, c) => s + c.keptGames, 0) /
      Math.max(1, them.reduce((s, c) => s + c.clubGames, 0));

    console.log(`${what.padEnd(28)} ${String(them.length).padStart(5)}   ` +
      `${f(so.made / Math.max(1, so.att) * 100, 0).padStart(9)}%   ` +
      `${f(after.made / Math.max(1, after.att) * 100, 0).padStart(9)}%  ` +
      `${f(after.exp / Math.max(1, after.att) * 100, 0).padStart(9)}%   ` +
      `${f(kept * 100, 0).padStart(10)}%   ` +
      `${f(mean(them.map((c) => c.pointsPerClubGame))).padStart(12)}   ` +
      `${f(mean(them.map((c) => c.so.points / c.so.games))).padStart(14)}`);
  }

  // 3. losing the job: kicked in under half the club's games left
  const lost = (c: Cut) => c.keptGames < c.clubGames / 2;
  console.log(`\nlost the job (under half the club's games left): ` +
    `${cuts.filter(lost).length} of ${cuts.length}`);

  // 4. what a manager gets over the club's games left, against the reads
  const ys = cuts.map((c) => c.pointsPerClubGame);
  const read = (what: string, xs: number[]) =>
    console.log(`  ${what.padEnd(36)} corr ${f(corr(xs, ys), 3)}`);
  console.log("\nwhat he goes on to score for whoever holds him, a club game, against:");
  read("his points a game so far", cuts.map((c) => c.so.points / c.so.games));
  read("his makes over expected so far", cuts.map((c) => overExpected(c.so)));
  read("his makes over expected, a game", cuts.map((c) => overExpected(c.so) / c.so.games));
  read("his field goal attempts a game", cuts.map((c) => c.so.attempts / c.so.games));
  read("his extra point misses", cuts.map((c) => c.so.xpMade - c.so.xpAttempts));
}

void main();

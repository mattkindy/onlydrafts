/**
 * How much of the rest of a season a player goes on to play, once some of
 * it has been played, against what his injury history said.
 *
 * At weeks 4, 6, 8 and 10 of 2017 to 2025, every QB, RB, WR and TE scoring
 * 8 half PPR points a game who played his side's last game is read two
 * ways: his history, the share of his side's games he played over the two
 * seasons before, and that history with the share he has played this
 * season. The line for the second is fitted on 2017 to 2021, weighted by
 * the games left, and both are marked on 2022 to 2025 by their error in
 * the share of the remaining games he played.
 *
 * The first table is the plain question behind it: of the players who had
 * played every game so far, how much of the rest they played, by what
 * their history said.
 *
 * Run: npx tsx scripts/availabilityNowEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const CUTS = [4, 6, 8, 10];
const FITTED_THROUGH = 2021;
/** points a game so far that make him somebody's starter */
const STARTER = 8;

interface Cut {
  season: number;
  cut: number;
  history: number;
  season_: number;
  rest: number;
  left: number;
}

const mean = (xs: number[]) =>
  xs.reduce((sum, x) => sum + x, 0) / Math.max(1, xs.length);

const pct = (x: number) => `${Math.round(100 * x)}%`;

async function main(): Promise<void> {
  const sideWeeks = new Map<string, number[]>();

  for (const g of await loadGames()) {
    if (g.homeScore === undefined) {
      continue;
    }

    for (const side of [g.homeTeamId, g.awayTeamId]) {
      const at = `${g.season}|${side}`;

      sideWeeks.set(at, [...(sideWeeks.get(at) ?? []), g.week]);
    }
  }

  /** each player's games, by season, as week to side and points */
  const played = new Map<number, Map<string, Map<number, { side: string; points: number }>>>();

  for (let season = 2015; season <= 2025; season++) {
    const his = new Map<string, Map<number, { side: string; points: number }>>();

    for (const row of await loadPlayerStats(season)) {
      if (!POSITIONS.has(row.position) || row.week > 18) {
        continue;
      }

      const weeks = his.get(row.playerId) ?? new Map();

      weeks.set(row.week, {
        side: row.teamId, points: fantasyPoints(row.statLine, presets.half),
      });
      his.set(row.playerId, weeks);
    }

    played.set(season, his);
  }

  const sideOf = (weeks: Map<number, { side: string }>) => {
    const counts = new Map<string, number>();

    for (const { side } of weeks.values()) {
      counts.set(side, (counts.get(side) ?? 0) + 1);
    }

    return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  };

  const shareOf = (season: number, playerId: string) => {
    const weeks = played.get(season)?.get(playerId);

    if (!weeks) {
      return null;
    }

    const games = sideWeeks.get(`${season}|${sideOf(weeks)}`)?.length || 17;

    return Math.min(1, weeks.size / games);
  };

  const cuts: Cut[] = [];

  for (let season = 2017; season <= 2025; season++) {
    for (const [playerId, weeks] of played.get(season)!) {
      const schedule = [...(sideWeeks.get(`${season}|${sideOf(weeks)}`) ?? [])]
        .sort((a, b) => a - b);
      const history = [shareOf(season - 1, playerId), shareOf(season - 2, playerId)]
        .filter((x): x is number => x !== null);

      if (history.length === 0) {
        continue;
      }

      for (const cut of CUTS) {
        const before = schedule.filter((w) => w <= cut);
        const after = schedule.filter((w) => w > cut);
        const got = before.filter((w) => weeks.has(w));

        if (got.length < 2 || after.length === 0 || !weeks.has(before[before.length - 1]!)) {
          continue;
        }

        if (mean(got.map((w) => weeks.get(w)!.points)) < STARTER) {
          continue;
        }

        cuts.push({
          season, cut,
          history: mean(history),
          season_: got.length / before.length,
          rest: after.filter((w) => weeks.has(w)).length / after.length,
          left: after.length,
        });
      }
    }
  }

  console.log("every game so far, by what the history said");
  console.log("history     cut   n      says    played");

  for (const [lo, hi] of [[0, 0.6], [0.6, 0.75], [0.75, 0.9], [0.9, 1.01]] as const) {
    for (const cut of [6, 10]) {
      const rows = cuts.filter((c) => c.cut === cut && c.season_ === 1 &&
        c.history >= lo && c.history < hi);

      console.log(`${pct(lo)}-${pct(Math.min(hi, 1))}`.padEnd(12) +
        `${cut}`.padEnd(6) + `${rows.length}`.padEnd(7) +
        `${pct(mean(rows.map((c) => c.history)))}`.padEnd(8) +
        pct(mean(rows.map((c) => c.rest))));
    }
  }

  const [a, b, c] = fitLine(cuts.filter((x) => x.season <= FITTED_THROUGH));
  const marked = cuts.filter((x) => x.season > FITTED_THROUGH);
  const line = (x: Cut) => Math.min(1, a + b * x.history + c * x.season_);
  const error = (said: (x: Cut) => number) =>
    marked.reduce((sum, x) => sum + Math.abs(said(x) - x.rest) * x.left, 0) /
    marked.reduce((sum, x) => sum + x.left, 0);

  console.log(`\nfitted on 2017-${FITTED_THROUGH}: rest = ${a.toFixed(3)} + ` +
    `${b.toFixed(3)} x history + ${c.toFixed(3)} x this season`);
  console.log(`${FITTED_THROUGH + 1}-2025, ${marked.length} cuts, error a player: ` +
    `history ${error((x) => x.history).toFixed(3)}, line ${error(line).toFixed(3)}`);

  for (const [lo, hi] of [[0, 0.75], [0.75, 0.85], [0.85, 1.01]] as const) {
    const rows = marked.filter((x) => line(x) >= lo && line(x) < hi);

    console.log(`  line says ${pct(lo)}-${pct(Math.min(hi, 1))}: ${rows.length} cuts, ` +
      `says ${pct(mean(rows.map(line)))}, played ${pct(mean(rows.map((x) => x.rest)))}`);
  }
}

/** rest = a + b history + c season, least squares weighted by games left */
function fitLine(cuts: Cut[]): [number, number, number] {
  const rows = cuts.map((x) => [1, x.history, x.season_]);
  const sums = [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
    rows.reduce((sum, r, k) => sum + cuts[k]!.left * r[i]! * r[j]!, 0)));
  const target = [0, 1, 2].map((i) =>
    rows.reduce((sum, r, k) => sum + cuts[k]!.left * r[i]! * cuts[k]!.rest, 0));
  const m = sums.map((row, i) => [...row, target[i]!]);

  for (let i = 0; i < 3; i++) {
    const pivot = m[i]![i]!;

    for (let r = 0; r < 3; r++) {
      if (r !== i) {
        const by = m[r]![i]! / pivot;

        m[r] = m[r]!.map((v, k) => v - by * m[i]![k]!);
      }
    }
  }

  return [0, 1, 2].map((i) => m[i]![3]! / m[i]![i]!) as [number, number, number];
}

await main();

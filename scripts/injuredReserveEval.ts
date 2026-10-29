/**
 * What going on injured reserve costs a player who matters, and what he
 * scores once he is back.
 *
 * Over the regular seasons 2016 to 2025, every QB, RB, WR and TE whose
 * weekly roster status goes from ACT one week to RES the next is a
 * placement, and the ones who had averaged seven half PPR points over two
 * or more games before it are the ones a fantasy roster cares about. He
 * is back the first game his side plays that he has a stat row in.
 *
 * Three things come out. How many of his side's games he misses from the
 * placement, censored at the end of the season, which for a fantasy team
 * is a game missed all the same. The same given he has already sat some
 * of them, since the app sees a man who has been on the list a while.
 * And his points in each of his first games back against his points
 * before, beside a control of players at the same level who never went
 * on the list, since cutting at seven points builds in a fall of its own.
 *
 * Run: npx tsx scripts/injuredReserveEval.ts [--seasons 2016-2025]
 */

import {
  loadGames, loadPlayerStats, loadWeeklyRosters,
} from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { seasonsAsked } from "../src/data/seasons.js";

const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
/** points a game before the placement that makes him somebody's starter */
const MATTERS = 7;
/** the weeks the control is cut at, early, middle and late */
const CONTROL_CUTS = [6, 9, 12];

interface Placement {
  week: number;
  ppg: number;
  /** his side's games from the placement on */
  left: number;
  missed: number;
  back: boolean;
  /** his points in each game from his return on */
  after: number[];
}

const mean = (xs: number[]) =>
  xs.reduce((sum, x) => sum + x, 0) / Math.max(1, xs.length);

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const fixed = (n: number, places = 2) => n.toFixed(places);

async function main() {
  const seasons = seasonsAsked(
    process.argv, Array.from({ length: 10 }, (_, i) => 2016 + i));
  const games = await loadGames();
  const placements: Placement[] = [];
  const control: { ppg: number; after: number[] }[] = [];

  for (const season of seasons) {
    const sideWeeks = new Map<string, number[]>();

    for (const game of games.filter((g) => g.season === season)) {
      for (const side of [game.homeTeamId, game.awayTeamId]) {
        sideWeeks.set(side, [...(sideWeeks.get(side) ?? []), game.week]);
      }
    }

    for (const weeks of sideWeeks.values()) {
      weeks.sort((a, b) => a - b);
    }

    const scored = new Map<string, Map<number, number>>();

    for (const row of await loadPlayerStats(season)) {
      const his = scored.get(row.playerId) ?? new Map<number, number>();

      his.set(row.week, fantasyPoints(row.statLine, presets.half));
      scored.set(row.playerId, his);
    }

    const listed = new Map<string, Map<number, { status: string; team: string }>>();

    for (const row of await loadWeeklyRosters(season)) {
      if (!POSITIONS.has(row.rawPosition) || !row.status) {
        continue;
      }

      const his = listed.get(row.playerId) ?? new Map();

      his.set(row.week, { status: row.status, team: row.teamId });
      listed.set(row.playerId, his);
    }

    for (const [playerId, his] of listed) {
      const points = scored.get(playerId) ?? new Map<number, number>();
      const before = (team: string, week: number) =>
        (sideWeeks.get(team) ?? [])
          .filter((w) => w < week && points.has(w))
          .map((w) => points.get(w)!);
      const everListed = [...his.values()].some((w) => w.status === "RES");

      if (!everListed) {
        for (const cut of CONTROL_CUTS) {
          const at = his.get(cut);
          const had = at ? before(at.team, cut) : [];

          if (at && had.length >= 2 && mean(had) >= MATTERS) {
            control.push({
              ppg: mean(had),
              after: (sideWeeks.get(at.team) ?? [])
                .filter((w) => w >= cut && points.has(w))
                .map((w) => points.get(w)!),
            });
          }
        }

        continue;
      }

      for (const [week, at] of his) {
        if (at.status !== "RES" || his.get(week - 1)?.status !== "ACT") {
          continue;
        }

        const had = before(at.team, week);

        if (had.length < 2) {
          continue;
        }

        const remaining = (sideWeeks.get(at.team) ?? []).filter((w) => w >= week);
        const back = remaining.find((w) => points.has(w));

        placements.push({
          week,
          ppg: mean(had),
          left: remaining.length,
          missed: back === undefined ? remaining.length : remaining.indexOf(back),
          back: back !== undefined,
          after: back === undefined
            ? []
            : remaining.filter((w) => w >= back && points.has(w))
              .map((w) => points.get(w)!),
        });
      }
    }
  }

  const matter = placements.filter((p) => p.ppg >= MATTERS);

  console.log(
    `${placements.length} placements, ${matter.length} of players ` +
      `averaging ${MATTERS} or more`);

  console.log("\nby the week he went on the list");
  for (const [lo, hi] of [[1, 5], [6, 9], [10, 18]] as const) {
    const group = matter.filter((p) => p.week >= lo && p.week <= hi);

    console.log(
      `  weeks ${lo}-${hi}: ${group.length}, back ` +
        `${fixed(mean(group.map((p) => Number(p.back))))}, missed median ` +
        `${median(group.map((p) => p.missed))} mean ` +
        `${fixed(mean(group.map((p) => p.missed)), 1)} of ` +
        `${fixed(mean(group.map((p) => p.left)), 1)} left`);
  }

  const long = matter.filter((p) => p.left >= 12);

  console.log(`\nback within k games, of the ${long.length} with 12 or more left`);
  for (let k = 0; k <= 12; k++) {
    console.log(`  ${k}: ${fixed(mean(long.map((p) =>
      Number(p.back && p.missed <= k))), 3)}`);
  }

  console.log("\nhaving already sat j games, with 6 or more still left");
  for (let j = 0; j <= 8; j++) {
    const group = matter.filter((p) => p.missed >= j && p.left - j >= 6);

    if (group.length < 15) {
      continue;
    }

    console.log(
      `  j=${j}: ${group.length}, misses ` +
        `${fixed(mean(group.map((p) => p.missed - j)), 1)} more of ` +
        `${fixed(mean(group.map((p) => p.left - j)), 1)}, never back ` +
        `${fixed(mean(group.map((p) => Number(!p.back))))}`);
  }

  /** points in the nth game after, against points before, as a ratio of means */
  const ratioAt = (rows: { ppg: number; after: number[] }[], n: number) => {
    const had = rows.filter((r) => r.after.length > n);

    return mean(had.map((r) => r.after[n]!)) / mean(had.map((r) => r.ppg));
  };

  console.log("\nnth game back against before, and the control at its cut");
  const returned = matter.filter((p) => p.after.length >= 4);

  for (let n = 0; n < 4; n++) {
    console.log(
      `  game ${n + 1}: back ${fixed(ratioAt(returned, n), 3)}, control ` +
        `${fixed(ratioAt(control, n), 3)}`);
  }

  for (const [lo, hi] of [[1, 3], [4, 7], [8, 18]] as const) {
    const group = returned.filter((p) => p.missed >= lo && p.missed <= hi);

    if (group.length === 0) {
      continue;
    }

    const firstTwo = mean(group.flatMap((p) => p.after.slice(0, 2))) /
      mean(group.map((p) => p.ppg));
    const rest = mean(group.flatMap((p) => p.after.slice(2))) /
      mean(group.map((p) => p.ppg));

    console.log(
      `  out ${lo}-${hi}: ${group.length}, first two back ${fixed(firstTwo, 3)}, ` +
        `after that ${fixed(rest, 3)}`);
  }

  console.log(`  control over all ${control.length}: ${fixed(mean(
    control.flatMap((c) => c.after)) / mean(control.map((c) => c.ppg)), 3)}`);
}

await main();

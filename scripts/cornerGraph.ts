/**
 * A shadow corner never shows up in a box score, but the week he took
 * away a team's best receiver does. Rather than charting who covered
 * whom, relate the two sides through the week they met: this receiver
 * faced that secondary, so whatever the secondary did to receivers
 * like him is what we want.
 *
 * The test is whether a defence suppresses the opponent's best
 * receiver more than it suppresses his team-mates, and whether that
 * habit is a stable thing about the defence rather than noise.
 *
 * Run: npx tsx scripts/cornerGraph.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

interface Meeting {
  season: number;
  week: number;
  defence: string;
  /** the receiver's rank in his own team's target order that season */
  rank: number;
  points: number;
  expected: number;
}

async function main(): Promise<void> {
  const games = await loadGames();
  const meetings: Meeting[] = [];

  for (const season of SEASONS) {
    const stats = await loadPlayerStats(season);

    // who each team's first, second and third receiver were
    const targetsBy = new Map<string, { team: string; targets: number; position: string }>();

    for (const s of stats) {
      const e = targetsBy.get(s.playerId) ??
        { team: s.teamId, targets: 0, position: s.position };
      e.targets += s.targets;
      targetsBy.set(s.playerId, e);
    }

    const order = new Map<string, number>();
    const byTeam = new Map<string, [string, number][]>();

    for (const [id, e] of targetsBy) {
      if (e.position !== "WR") continue;
      byTeam.set(e.team, [...(byTeam.get(e.team) ?? []), [id, e.targets]]);
    }

    for (const list of byTeam.values()) {
      list.sort((a, b) => b[1] - a[1]);
      list.forEach(([id], i) => order.set(id, i + 1));
    }

    // what each receiver usually did, so we can see what a defence took away
    const own = new Map<string, { total: number; games: number }>();

    for (const s of stats) {
      if (!order.has(s.playerId)) continue;
      const e = own.get(s.playerId) ?? { total: 0, games: 0 };
      e.total += fantasyPoints(s.statLine, presets.standard);
      e.games++;
      own.set(s.playerId, e);
    }

    const opponentOf = new Map<string, string>();

    for (const game of games) {
      if (game.season !== season) continue;
      opponentOf.set(`${game.homeTeamId}|${game.week}`, game.awayTeamId);
      opponentOf.set(`${game.awayTeamId}|${game.week}`, game.homeTeamId);
    }

    for (const s of stats) {
      const rank = order.get(s.playerId);
      const usual = own.get(s.playerId);
      const defence = opponentOf.get(`${s.teamId}|${s.week}`);
      if (!rank || rank > 3 || !usual || usual.games < 8 || !defence) continue;
      meetings.push({
        season, week: s.week, defence, rank,
        points: fantasyPoints(s.statLine, presets.standard),
        expected: usual.total / usual.games,
      });
    }
  }

  // how much each defence held each tier below its usual level
  const byDefence = new Map<string, Map<number, number[]>>();

  for (const m of meetings) {
    const tiers = byDefence.get(`${m.defence}|${m.season}`) ?? new Map<number, number[]>();
    tiers.set(m.rank, [...(tiers.get(m.rank) ?? []), m.points - m.expected]);
    byDefence.set(`${m.defence}|${m.season}`, tiers);
  }

  interface Row { key: string; defence: string; season: number; top: number; rest: number; }
  const rows: Row[] = [];
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  for (const [key, tiers] of byDefence) {
    const top = tiers.get(1) ?? [];
    const rest = [...(tiers.get(2) ?? []), ...(tiers.get(3) ?? [])];
    if (top.length < 10 || rest.length < 15) continue;
    const [defence, season] = key.split("|");
    rows.push({ key, defence: defence!, season: Number(season), top: mean(top), rest: mean(rest) });
  }

  console.log(`${meetings.length} receiver-weeks, ${rows.length} defence-seasons\n`);

  const shadow = rows.map((r) => r.top - r.rest);
  const sorted = [...shadow].sort((a, b) => a - b);
  console.log("points a defence takes off the opposing WR1, over and above what");
  console.log("it takes off WR2 and WR3 the same day:\n");
  console.log("  toughest on the star   " + sorted[0]!.toFixed(2));
  console.log("  typical                " + sorted[Math.floor(sorted.length / 2)]!.toFixed(2));
  console.log("  easiest on the star    " + sorted.at(-1)!.toFixed(2));

  // does it carry over? that is what makes it usable in advance
  const byKey = new Map(rows.map((r) => [`${r.defence}|${r.season}`, r]));
  const pairs: [Row, Row][] = [];

  for (const r of rows) {
    const prev = byKey.get(`${r.defence}|${r.season - 1}`);
    if (prev) pairs.push([prev, r]);
  }

  console.log(`\nyear over year, ${pairs.length} pairs:`);
  console.log("  overall suppression of everyone   " +
    spearman(pairs.map(([a]) => a.rest), pairs.map(([, b]) => b.rest)).toFixed(3));
  console.log("  extra suppression of the WR1      " +
    spearman(pairs.map(([a]) => a.top - a.rest), pairs.map(([, b]) => b.top - b.rest)).toFixed(3));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

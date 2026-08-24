/**
 * Which team-level habits belong to the coach? Compare a team's habit
 * one season to the next, split by whether the same man was still
 * calling the plays. A habit that survives a coordinator change
 * belongs to the roster; one that leaves with him is his, and since
 * hires are announced in January it is knowable before a draft.
 *
 * Run: npx tsx scripts/coachPersistence.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadCoaches } from "../src/data/coaches.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

interface TeamSeason {
  team: string;
  season: number;
  plays: number;
  passShare: number;
  /** how much of the backfield's work the lead back takes */
  leadBackShare: number;
  /** how much of the target pool the top receiver takes */
  topTargetShare: number;
  /** share of the team's scores taken by its most-used scorer */
  topScoreShare: number;
  oc: string;
  hc: string;
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const rows: TeamSeason[] = [];

  for (const season of SEASONS) {
    const stats = await loadPlayerStats(season);
    const byTeam = new Map<string, typeof stats>();

    for (const s of stats) {
      byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
    }

    for (const [team, list] of byTeam) {
      const games = new Set(list.map((s) => s.week)).size;

      if (games < 14) {
        continue;
      }

      const targets = list.reduce((a, s) => a + s.targets, 0);
      const carries = list.reduce((a, s) => a + s.carries, 0);

      const byPlayer = new Map<string, { targets: number; carries: number; scores: number; position: string }>();

      for (const s of list) {
        const e = byPlayer.get(s.playerId) ??
          { targets: 0, carries: 0, scores: 0, position: s.position };
        e.targets += s.targets;
        e.carries += s.carries;
        e.scores += (s.statLine.rushTd ?? 0) + (s.statLine.recTd ?? 0);
        byPlayer.set(s.playerId, e);
      }

      const all = [...byPlayer.values()];
      const backs = all.filter((p) => p.position === "RB");
      const catchers = all.filter((p) => p.position !== "RB");
      const scores = all.reduce((a, p) => a + p.scores, 0);

      rows.push({
        team, season,
        plays: (targets + carries) / games,
        passShare: targets / Math.max(1, targets + carries),
        leadBackShare: carries > 0
          ? Math.max(0, ...backs.map((p) => p.carries)) / carries : 0,
        topTargetShare: targets > 0
          ? Math.max(0, ...catchers.map((p) => p.targets)) / targets : 0,
        topScoreShare: scores > 0
          ? Math.max(0, ...all.map((p) => p.scores)) / scores : 0,
        oc: coaches.get(`${team}|${season}|OC`) ?? "",
        hc: coaches.get(`${team}|${season}|HC`) ?? "",
      });
    }
  }

  const byKey = new Map(rows.map((r) => [`${r.team}|${r.season}`, r]));
  const pairs: { prev: TeamSeason; next: TeamSeason; sameOc: boolean }[] = [];

  for (const row of rows) {
    const prev = byKey.get(`${row.team}|${row.season - 1}`);

    if (prev && prev.oc && row.oc) {
      pairs.push({ prev, next: row, sameOc: prev.oc === row.oc && prev.hc === row.hc });
    }
  }

  const kept = pairs.filter((p) => p.sameOc);
  const changed = pairs.filter((p) => !p.sameOc);

  console.log(`${pairs.length} team-season pairs, ${kept.length} kept the staff, ${changed.length} changed it\n`);
  console.log("habit                     same staff   new staff   the coach's share");

  for (const [label, get] of [
    ["plays a game", (r: TeamSeason) => r.plays],
    ["pass share", (r: TeamSeason) => r.passShare],
    ["lead back's carry share", (r: TeamSeason) => r.leadBackShare],
    ["top receiver's targets", (r: TeamSeason) => r.topTargetShare],
    ["top scorer's share", (r: TeamSeason) => r.topScoreShare],
  ] as [string, (r: TeamSeason) => number][]) {
    const a = spearman(kept.map((p) => get(p.prev)), kept.map((p) => get(p.next)));
    const b = spearman(changed.map((p) => get(p.prev)), changed.map((p) => get(p.next)));
    console.log(
      label.padEnd(26) + a.toFixed(3).padStart(10) + b.toFixed(3).padStart(12) +
      (a - b).toFixed(3).padStart(20),
    );
  }

  console.log("\nthe last column is how much of the habit walks out with the coordinator");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

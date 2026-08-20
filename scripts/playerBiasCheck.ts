/**
 * Whom the played games get wrong, and whether it rhymes.
 *
 * Run: npx tsx scripts/playerBiasCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;
const SEASON = 2025;

async function main(): Promise<void> {
  const kept = JSON.parse(await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${SEASON}.json`),
    "utf8",
  )) as { total: [string, number][]; games: [string, number][] };
  const says = new Map(kept.total);

  const names = new Map<string, string>();
  const positions = new Map<string, string>();
  const scored = new Map<string, number>();
  const weeks = new Map<string, number>();

  for (const s of await loadPlayerStats(SEASON)) {
    if (s.week > 17) continue;
    names.set(s.playerId, s.playerName);
    positions.set(s.playerId, s.position);
    scored.set(s.playerId, (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES));
    weeks.set(s.playerId, (weeks.get(s.playerId) ?? 0) + 1);
  }

  const rookieYear = new Map<string, number>();

  for (const row of await loadWeeklyRosters(SEASON)) {
    if (row.draftYear !== undefined) rookieYear.set(row.playerId, row.draftYear);
  }

  const men = [...scored.entries()]
    .filter(([id, points]) => points >= 60 &&
      ["RB", "WR", "TE", "QB"].includes(positions.get(id) ?? ""))
    .map(([id, really]) => ({
      id, name: names.get(id) ?? id, position: positions.get(id) ?? "",
      really, says: says.get(id) ?? 0,
      gap: (says.get(id) ?? 0) - really,
      rookie: rookieYear.get(id) === SEASON,
      games: weeks.get(id) ?? 0,
    }));

  const under = [...men].sort((a, b) => a.gap - b.gap).slice(0, 14);
  const over = [...men].sort((a, b) => b.gap - a.gap).slice(0, 14);

  console.log("most underestimated, points over the season\n");
  for (const m of under) {
    console.log(
      "  " + `${m.name} (${m.position})`.padEnd(30) +
        `said ${m.says.toFixed(0).padStart(4)}  really ${m.really.toFixed(0).padStart(4)}` +
        (m.rookie ? "   rookie" : "") +
        (says.get(m.id) === undefined ? "   never rostered" : ""),
    );
  }
  console.log("\nmost overestimated\n");
  for (const m of over) {
    console.log(
      "  " + `${m.name} (${m.position})`.padEnd(30) +
        `said ${m.says.toFixed(0).padStart(4)}  really ${m.really.toFixed(0).padStart(4)}` +
        `   played ${m.games}`,
    );
  }

  const groups: [string, (m: (typeof men)[number]) => boolean][] = [
    ["rookies", (m) => m.rookie],
    ["missed 4 or more games", (m) => !m.rookie && m.games <= 13],
    ["veterans who played", (m) => !m.rookie && m.games > 13],
  ];
  console.log("\nthe gap by kind of man, said less really, points a season\n");
  for (const [label, is] of groups) {
    const these = men.filter(is);
    const mid = these.reduce((a, m) => a + m.gap, 0) / Math.max(1, these.length);
    console.log("  " + label.padEnd(24) + String(these.length).padStart(4) +
      "   " + (mid >= 0 ? "+" : "") + mid.toFixed(1));
  }
}

main().catch((error) => { console.error(error); process.exit(1); });

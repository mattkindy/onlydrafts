/**
 * Is the coverage proxy worth having?
 *
 * Two checks. It should name the men who are known to be good, and a
 * defender's coverage should come back next season, since a measure
 * that does not carry over is describing the afternoon rather than the
 * man.
 *
 * Run: npx tsx scripts/coverageEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadWeeklyRosters } from "../src/data/nflverse.js";
import { spearman } from "../src/backtest/metrics.js";

interface Season {
  season: number; player: string; name: string; spot: string;
  targets: number; catchRate: number; yardsPerTarget: number;
  scoreRate: number; takeawayRate: number;
}

async function main(): Promise<void> {
  const raw = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "coverage.csv"), "utf8"),
  );
  const names = new Map<string, string>();

  for (const season of [2021, 2022, 2023, 2024, 2025]) {
    for (const row of await loadWeeklyRosters(season)) {
      names.set(row.playerId, row.name);
    }
  }

  const rows: Season[] = raw.map((r) => {
    const targets = Number(r["targets"]);
    return {
      season: Number(r["season"]),
      player: r["player"] ?? "",
      spot: r["spot"] ?? "",
      name: names.get(r["player"] ?? "") ?? r["player"] ?? "",
      targets,
      catchRate: Number(r["completions"]) / targets,
      yardsPerTarget: Number(r["yards"]) / targets,
      scoreRate: Number(r["touchdowns"]) / targets,
      takeawayRate:
        (Number(r["interceptions"]) + Number(r["brokenUp"])) / targets,
    };
  });

  const busy = rows.filter((r) => r.targets >= 30 && r.spot === "CB");
  console.log(`${rows.length} defender-seasons, ${busy.length} with thirty or more\n`);

  const show = (label: string, of: Season[], get: (s: Season) => number, best: "low" | "high") => {
    const sorted = [...of].sort((a, b) =>
      best === "low" ? get(a) - get(b) : get(b) - get(a));
    console.log("  " + label);
    console.log("    " + sorted.slice(0, 5)
      .map((s) => s.name + " " + get(s).toFixed(2)).join(", "));
  };

  const recent = busy.filter((r) => r.season === 2024 && r.spot === "CB");
  console.log("2024 corners, thrown at thirty times or more\n");
  show("fewest yards allowed a target", recent, (s) => s.yardsPerTarget, "low");
  show("most yards allowed a target", recent, (s) => s.yardsPerTarget, "high");
  show("most balls broken up or picked", recent, (s) => s.takeawayRate, "high");

  const byKey = new Map(busy.map((r) => [`${r.player}|${r.season}`, r]));
  const pairs: [Season, Season][] = [];

  for (const row of busy) {
    const before = byKey.get(`${row.player}|${row.season - 1}`);
    if (before) pairs.push([before, row]);
  }

  console.log(`\nyear over year, ${pairs.length} pairs\n`);
  console.log("  measure                      spearman");

  for (const [label, get] of [
    ["how often he is thrown at", (s: Season) => s.targets],
    ["how often it is caught", (s: Season) => s.catchRate],
    ["yards allowed a target", (s: Season) => s.yardsPerTarget],
    ["balls broken up or picked", (s: Season) => s.takeawayRate],
  ] as [string, (s: Season) => number][]) {
    console.log(
      "  " + label.padEnd(30) +
      spearman(pairs.map(([a]) => get(a)), pairs.map(([, b]) => get(b)))
        .toFixed(3).padStart(8),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

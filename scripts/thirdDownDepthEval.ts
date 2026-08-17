/**
 * On third down, does a team throw to the sticks or short of them?
 *
 * I asserted that teams throw to the sticks, which is the kind of
 * claim that is either a league average hiding a spread or a real
 * habit that belongs in the model. This measures which, and whether
 * the habit goes with the coordinator.
 *
 * Run: npx tsx scripts/thirdDownDepthEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { loadCoaches } from "../src/data/coaches.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else cell += ch;
  }

  cells.push(cell);
  return cells;
}

interface TeamSeason {
  team: string;
  season: number;
  /** whoever threw it most for them that year */
  passer: string;
  /** air yards minus the distance, averaged over third down throws */
  pastTheSticks: number;
  /** share thrown short of the marker */
  shortOfIt: number;
  throws: number;
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const rows: TeamSeason[] = [];

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) {
      continue;
    }

    const byTeam = new Map<string, { past: number; short: number; throws: number }>();
    const passers = new Map<string, Map<string, number>>();
    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        for (const field of [
          "posteam", "down", "ydstogo", "air_yards", "play_type", "yardline_100",
          "passer_player_id",
        ]) {
          at[field] = header.indexOf(field);
        }
        continue;
      }

      const c = splitLine(line);
      const team = c[at["posteam"]!] ?? "";
      const air = Number(c[at["air_yards"]!]);
      const toGo = Number(c[at["ydstogo"]!]);
      const yardline = Number(c[at["yardline_100"]!]);

      // third and four or more, away from the goal line where the field
      // runs out and nobody can throw past the sticks
      if (
        c[at["play_type"]!] !== "pass" || Number(c[at["down"]!]) !== 3 ||
        !Number.isFinite(air) || !Number.isFinite(toGo) || toGo < 4 ||
        !Number.isFinite(yardline) || yardline < 25
      ) {
        continue;
      }

      const passer = c[at["passer_player_id"]!] ?? "";

      if (passer && passer !== "NA") {
        const seen = passers.get(team) ?? new Map<string, number>();
        seen.set(passer, (seen.get(passer) ?? 0) + 1);
        passers.set(team, seen);
      }

      const tally = byTeam.get(team) ?? { past: 0, short: 0, throws: 0 };
      tally.past += air - toGo;
      if (air < toGo) tally.short++;
      tally.throws++;
      byTeam.set(team, tally);
    }

    for (const [team, tally] of byTeam) {
      if (tally.throws < 80) continue;
      const mostThrows = [...(passers.get(team) ?? new Map())]
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      rows.push({
        team, season, passer: mostThrows,
        pastTheSticks: tally.past / tally.throws,
        shortOfIt: tally.short / tally.throws,
        throws: tally.throws,
      });
    }

    console.log(`${season}: ${byTeam.size} offences`);
  }

  const spread = [...rows].sort((a, b) => a.pastTheSticks - b.pastTheSticks);
  console.log(`\n${rows.length} team-seasons, third and four or more\n`);
  console.log("air yards beyond the marker, averaged:");
  console.log("  shortest    " + spread[0]!.pastTheSticks.toFixed(2) +
    "   (" + spread[0]!.team + " " + spread[0]!.season + ")");
  console.log("  median      " + spread[Math.floor(spread.length / 2)]!.pastTheSticks.toFixed(2));
  console.log("  deepest     " + spread.at(-1)!.pastTheSticks.toFixed(2) +
    "   (" + spread.at(-1)!.team + " " + spread.at(-1)!.season + ")");
  console.log("\nshare thrown short of the marker: " +
    (Math.min(...rows.map((r) => r.shortOfIt)) * 100).toFixed(0) + "% to " +
    (Math.max(...rows.map((r) => r.shortOfIt)) * 100).toFixed(0) + "%");

  const byKey = new Map(rows.map((r) => [`${r.team}|${r.season}`, r]));
  const pairs: { before: TeamSeason; after: TeamSeason; kept: boolean }[] = [];

  for (const row of rows) {
    const before = byKey.get(`${row.team}|${row.season - 1}`);
    if (!before) continue;
    const now = coaches.get(`${row.team}|${row.season}|OC`) ?? "";
    const then = coaches.get(`${row.team}|${row.season - 1}|OC`) ?? "";
    if (!now || !then) continue;
    pairs.push({ before, after: row, kept: now === then });
  }

  const score = (list: typeof pairs, get: (r: TeamSeason) => number) =>
    list.length >= 12
      ? spearman(list.map((p) => get(p.before)), list.map((p) => get(p.after)))
          .toFixed(3).padStart(11)
      : "too few".padStart(11);

  console.log("\nwhat comes back next season, by what stayed and what left\n");
  console.log("  group                            n   past the marker   short of it");

  for (const [label, sub] of [
    ["kept the play-caller", pairs.filter((p) => p.kept)],
    ["changed the play-caller", pairs.filter((p) => !p.kept)],
    ["kept the passer", pairs.filter((p) => p.before.passer === p.after.passer)],
    ["changed the passer", pairs.filter((p) => p.before.passer !== p.after.passer)],
    ["kept both", pairs.filter((p) => p.kept && p.before.passer === p.after.passer)],
    ["changed both", pairs.filter((p) => !p.kept && p.before.passer !== p.after.passer)],
  ] as [string, typeof pairs][]) {
    console.log(
      "  " + label.padEnd(28) + String(sub.length).padStart(4) +
      score(sub, (r) => r.pastTheSticks) + score(sub, (r) => r.shortOfIt),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

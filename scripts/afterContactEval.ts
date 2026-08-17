/**
 * Whether yards after contact says more about a back than yards a carry.
 *
 * A carry's yards are the line's as much as his: he runs through what
 * they open. What he does after he is hit should be his, and if it is
 * then it should last from one season to the next better than the
 * whole gain does.
 *
 * Run: npx tsx scripts/afterContactEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { RAW_DIR } from "../src/data/nflverse.js";

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface Rush {
  player: string;
  team: string;
  season: number;
  attempts: number;
  perCarry: number;
  beforeContact: number;
  afterContact: number;
  brokenPer: number;
}

async function rushing(): Promise<Rush[]> {
  return parseCsv(await readFile(join(RAW_DIR, "advstats_rush.csv"), "utf8"))
    .map((r) => ({
      player: r["pfr_id"] ?? "",
      team: r["tm"] ?? "",
      season: Number(r["season"]),
      attempts: Number(r["att"]) || 0,
      perCarry: Number(r["yds"]) / Math.max(1, Number(r["att"])),
      beforeContact: Number(r["ybc_att"]) || 0,
      afterContact: Number(r["yac_att"]) || 0,
      brokenPer: Number(r["att_br"]) || 0,
    }))
    .filter((r) => r.player && r.attempts >= 60);
}

async function main(): Promise<void> {
  const all = await rushing();
  const byPlayer = new Map<string, Map<number, Rush>>();

  for (const row of all) {
    const own = byPlayer.get(row.player) ?? new Map<number, Rush>();
    own.set(row.season, row);
    byPlayer.set(row.player, own);
  }

  const pairs: { before: Rush; after: Rush }[] = [];

  for (const own of byPlayer.values()) {
    for (const [season, before] of own) {
      const after = own.get(season + 1);
      if (after) pairs.push({ before, after });
    }
  }

  console.log(`${pairs.length} backs with sixty carries in two seasons running\n`);
  console.log("carried from one season to the next, as rank correlation, more is better");

  for (const [label, of] of [
    ["his yards a carry", (r: Rush) => r.perCarry],
    ["what he made before contact", (r: Rush) => r.beforeContact],
    ["what he made after contact", (r: Rush) => r.afterContact],
    ["how often he breaks a tackle", (r: Rush) => r.brokenPer],
  ] as [string, (r: Rush) => number][]) {
    console.log(
      "  " + label.padEnd(32) +
      spearman(pairs.map((p) => of(p.before)), pairs.map((p) => of(p.after)))
        .toFixed(4).padStart(7),
    );
  }

  console.log(`  give or take ${noise(pairs.length).toFixed(3)}`);

  console.log(
    "\n  what a carry is made of: " +
      `${(pairs.reduce((a, p) => a + p.after.beforeContact, 0) / pairs.length)
        .toFixed(2)} yards before contact and ` +
      `${(pairs.reduce((a, p) => a + p.after.afterContact, 0) / pairs.length)
        .toFixed(2)} after`,
  );

  /**
   * Which of the two follows a man when he leaves, and which stays
   * behind with the line. For a back who changed teams, his own number
   * from last season is put beside what his new team's other backs did,
   * and whichever lines up with what he goes on to make is whose it is.
   */
  const byTeamYear = new Map<string, Rush[]>();

  for (const row of all) {
    const key = `${row.season}|${row.team}`;
    byTeamYear.set(key, [...(byTeamYear.get(key) ?? []), row]);
  }

  const movers = pairs.filter((p) => p.before.team !== p.after.team);
  const kept: { his: number; theirs: number; became: number; part: string }[] = [];

  for (const part of ["beforeContact", "afterContact"] as const) {
    for (const move of movers) {
      // his new team-mates last season, without him in it
      const mates = (byTeamYear.get(`${move.before.season}|${move.after.team}`) ?? [])
        .filter((r) => r.player !== move.before.player);

      if (!mates.length) {
        continue;
      }

      kept.push({
        his: move.before[part],
        theirs: mates.reduce((a, r) => a + r[part], 0) / mates.length,
        became: move.after[part],
        part,
      });
    }
  }

  console.log(`\n  backs who changed teams, ${movers.length} of them`);
  console.log("    which of the two he ends up looking like, as rank correlation");
  console.log("    part              his own before   his new team's backs");

  for (const part of ["beforeContact", "afterContact"] as const) {
    const at = kept.filter((k) => k.part === part);

    if (at.length < 20) {
      continue;
    }

    console.log(
      "    " + (part === "beforeContact" ? "before contact" : "after contact").padEnd(18) +
      spearman(at.map((k) => k.his), at.map((k) => k.became)).toFixed(3).padStart(8) +
      spearman(at.map((k) => k.theirs), at.map((k) => k.became)).toFixed(3).padStart(21) +
      `   (${at.length})`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

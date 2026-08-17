/**
 * Personnel is a conversation. An offence picks a grouping, and the
 * defence answers with one, and what the offence gets to do next
 * depends on the answer.
 *
 * Going heavy pulls a defence into its base package, which is bigger
 * and slower, and that is the whole reason an offence does it. Going
 * with three receivers draws nickel.
 *
 * Run: npx tsx scripts/personnelAnswerEval.ts
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";

/**
 * The field lists actual positions rather than a shorthand, so count
 * the secondary: corners, both safeties, and anyone listed as a back.
 */
const shell = (text: string) => {
  let backs = 0;

  for (const spot of ["CB", "FS", "SS", "S", "DB"]) {
    backs += Number(new RegExp("(\\d+) " + spot + "(?:,|$)").exec(text)?.[1] ?? 0);
  }

  if (backs < 4) return "?";
  if (backs === 4) return "base";
  if (backs === 5) return "nickel";
  return "dime or more";
};

const offenseGroup = (text: string) => {
  const rb = Number(/(\d+) RB/.exec(text)?.[1] ?? NaN);
  const te = Number(/(\d+) TE/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(rb) || !Number.isFinite(te)) return "?";
  if (rb === 1 && te === 1) return "11 personnel";
  if (rb + te >= 3) return "heavy";
  return "other";
};

async function main() {
  const r = createInterface({
    input: createReadStream(join(RAW_DIR, "participation_2024.csv")),
  });
  let header: string[] | undefined;
  const table = new Map<string, Map<string, number>>();
  const box = new Map<string, { total: number; plays: number }>();

  for await (const line of r) {
    if (!header) { header = splitLine(line); continue; }
    const c = splitLine(line);
    const off = offenseGroup(c[header.indexOf("offense_personnel")] ?? "");
    const def = shell(c[header.indexOf("defense_personnel")] ?? "");
    if (off === "?" || def === "?" || off === "other") continue;
    const row = table.get(off) ?? new Map();
    row.set(def, (row.get(def) ?? 0) + 1);
    table.set(off, row);
    const inBox = Number(c[header.indexOf("defenders_in_box")]);
    if (Number.isFinite(inBox) && inBox > 0) {
      const b = box.get(off) ?? { total: 0, plays: 0 };
      b.total += inBox; b.plays++;
      box.set(off, b);
    }
  }

  console.log("what the defence answers with, 2024\n");
  console.log("offence lines up in    base    nickel   dime+   men in the box");
  for (const [off, row] of table) {
    const total = [...row.values()].reduce((a, b) => a + b, 0);
    const pct = (k: string) => (((row.get(k) ?? 0) / total) * 100).toFixed(1) + "%";
    const b = box.get(off)!;
    console.log(
      off.padEnd(22) + pct("base").padStart(6) + pct("nickel").padStart(9) +
      pct("dime or more").padStart(8) + (b.total / b.plays).toFixed(2).padStart(16),
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

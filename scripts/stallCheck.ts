/**
 * Why the walk stalls more often than drives really do.
 *
 * It ends 36.7% of drives in three plays or fewer where the real
 * number is 25%, and the yards come from what such plays really gained,
 * so the leak is somewhere between the draw and the chains. This
 * compares the two at each down: how often a set of downs is converted,
 * and what the distance to go looks like when it is faced.
 *
 * Run: npx tsx scripts/stallCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { simulateDrive } from "../src/model/drive.js";

const band = (toGo: number) =>
  toGo <= 2 ? "1-2" : toGo <= 6 ? "3-6" : toGo <= 10 ? "7-10" : "11+";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const rows = parseCsv(
    await readFile(
      join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
    ),
  ).filter((r) => ["run", "pass"].includes(r["playType"] ?? ""));

  // what really happens: how often a play gains what it needs
  const real = new Map<string, { got: number; all: number; toGo: number[] }>();

  for (const row of rows) {
    const down = Number(row["down"]);
    const toGo = Number(row["togo"]);
    const key = `${down}|${band(toGo)}`;
    const tally = real.get(key) ?? { got: 0, all: 0, toGo: [] };
    tally.all++;
    tally.toGo.push(toGo);
    if (Number(row["yards"]) >= toGo) tally.got++;
    real.set(key, tally);
  }

  const rules = await fitDriveRules([2022, 2023, 2024, 2025]);
  const rng = seededRng(3);
  const normal = () => normalDraw(rng);
  const sim = new Map<string, { got: number; all: number; toGo: number[] }>();
  const lengths: number[] = [];

  for (let i = 0; i < 60000; i++) {
    const startAt = Math.max(35, Math.min(99, Math.round(75 + normal() * 13)));
    const drive = simulateDrive(startAt, rules, rng);
    lengths.push(drive.plays.length);

    for (const play of drive.plays) {
      const key = `${play.state.down}|${band(play.state.toGo)}`;
      const tally = sim.get(key) ?? { got: 0, all: 0, toGo: [] };
      tally.all++;
      tally.toGo.push(play.state.toGo);
      if (play.yards >= play.state.toGo) tally.got++;
      sim.set(key, tally);
    }
  }

  console.log("how often a play gains what it needs, and what it needed\n");
  console.log("  down  to go     really          walked");
  console.log("                  got   needed    got   needed   share of plays");

  for (const down of [1, 2, 3, 4]) {
    for (const width of ["1-2", "3-6", "7-10", "11+"]) {
      const key = `${down}|${width}`;
      const r = real.get(key);
      const s = sim.get(key);

      if (!r || !s || r.all < 200) {
        continue;
      }

      const seen = s.all / [...sim.values()].reduce((a, t) => a + t.all, 0);
      const was = r.all / [...real.values()].reduce((a, t) => a + t.all, 0);
      console.log(
        `  ${down}     ${width.padEnd(7)}` +
        `${(100 * r.got / r.all).toFixed(0).padStart(4)}%` +
        `${middle(r.toGo).toFixed(1).padStart(9)}` +
        `${(100 * s.got / s.all).toFixed(0).padStart(8)}%` +
        `${middle(s.toGo).toFixed(1).padStart(9)}` +
        `      ${(100 * was).toFixed(1)}% really, ${(100 * seen).toFixed(1)}% walked`,
      );
    }
  }

  console.log(
    `\nwalked drives run ${middle(lengths).toFixed(2)} plays, ` +
      `${(100 * lengths.filter((n) => n <= 3).length / lengths.length).toFixed(1)}% ` +
      "of them three or fewer",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

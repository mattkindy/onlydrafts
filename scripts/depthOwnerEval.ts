/**
 * Whose choice is it how far downfield a throw goes?
 *
 * A receiver's depth carries to the next season at .877, which is the
 * surest thing known about a player, but three people decide it: the
 * man running the route, the man throwing it and the man who called
 * it. Keep the receiver on the same team and change the other two,
 * separately and together, and whichever change moves him owns it.
 *
 * Run: npx tsx scripts/depthOwnerEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadCoaches } from "../src/data/coaches.js";

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Season {
  team: string;
  depths: number[];
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));

  /** each receiver's throws, by season */
  const byReceiver = new Map<string, Map<number, Season>>();
  /** and who threw for each side, so the main man can be found */
  const threw = new Map<string, Map<string, number>>();
  /** the passers' own depths, for the same question about them */
  const byPasser = new Map<string, Map<number, Season>>();

  for (const row of rows) {
    if (row["playType"] !== "pass" || row["airYards"] === "") {
      continue;
    }

    const depth = Number(row["airYards"]);

    if (!Number.isFinite(depth)) {
      continue;
    }

    const season = Number(row["season"]);
    const team = row["offense"] ?? "";
    const passer = row["passer"] ?? "";
    const receiver = row["player"] ?? "";

    if (passer) {
      const who = threw.get(`${team}|${season}`) ?? new Map<string, number>();
      who.set(passer, (who.get(passer) ?? 0) + 1);
      threw.set(`${team}|${season}`, who);

      const his = byPasser.get(passer) ?? new Map<number, Season>();
      const own = his.get(season) ?? { team, depths: [] };
      own.depths.push(depth);
      his.set(season, own);
      byPasser.set(passer, his);
    }

    if (receiver) {
      const his = byReceiver.get(receiver) ?? new Map<number, Season>();
      const own = his.get(season) ?? { team, depths: [] };
      own.depths.push(depth);
      his.set(season, own);
      byReceiver.set(receiver, his);
    }
  }

  const mainPasser = new Map<string, string>();

  for (const [key, who] of threw) {
    const most = [...who.entries()].sort((a, b) => b[1] - a[1])[0];

    if (most && most[1] >= 100) {
      mainPasser.set(key, most[0]);
    }
  }

  interface Moved {
    was: number;
    now: number;
    qbChanged: boolean;
    ocChanged: boolean;
  }

  const moved: Moved[] = [];

  for (const his of byReceiver.values()) {
    for (const [season, was] of his) {
      const now = his.get(season + 1);

      if (!now || now.team !== was.team) {
        continue;
      }

      if (was.depths.length < 30 || now.depths.length < 30) {
        continue;
      }

      const before = mainPasser.get(`${was.team}|${season}`);
      const after = mainPasser.get(`${now.team}|${season + 1}`);
      const oldOc = coaches.get(`${was.team}|${season}|OC`) ?? "";
      const newOc = coaches.get(`${now.team}|${season + 1}|OC`) ?? "";

      if (!before || !after || !oldOc || !newOc) {
        continue;
      }

      moved.push({
        was: middle(was.depths), now: middle(now.depths),
        qbChanged: before !== after, ocChanged: oldOc !== newOc,
      });
    }
  }

  console.log(
    `${moved.length} receiver seasons back to back at the same club\n`,
  );
  console.log(
    "how far downfield he is thrown, from one season to the next\n",
  );
  console.log(
    "  what changed around him        n   carries over   he moves by   give or take",
  );

  const groups: [string, (m: Moved) => boolean][] = [
    ["nothing", (m) => !m.qbChanged && !m.ocChanged],
    ["the quarterback", (m) => m.qbChanged && !m.ocChanged],
    ["the coordinator", (m) => !m.qbChanged && m.ocChanged],
    ["both of them", (m) => m.qbChanged && m.ocChanged],
  ];

  for (const [label, is] of groups) {
    const these = moved.filter(is);

    if (these.length < 8) {
      console.log("  " + label.padEnd(28) + String(these.length).padStart(4) +
        "   too few to say");
      continue;
    }

    console.log(
      "  " + label.padEnd(28) + String(these.length).padStart(4) +
        spearman(these.map((m) => m.was), these.map((m) => m.now))
          .toFixed(3).padStart(15) +
        middle(these.map((m) => Math.abs(m.now - m.was))).toFixed(2).padStart(14) +
        " yd" + noise(these.length).toFixed(3).padStart(12),
    );
  }

  // and the same question about the men throwing it
  const passerMoves: { was: number; now: number; sameTeam: boolean }[] = [];

  for (const his of byPasser.values()) {
    for (const [season, was] of his) {
      const now = his.get(season + 1);

      if (!now || was.depths.length < 100 || now.depths.length < 100) {
        continue;
      }

      passerMoves.push({
        was: middle(was.depths), now: middle(now.depths),
        sameTeam: was.team === now.team,
      });
    }
  }

  console.log("\nand how far the men throwing it throw\n");
  console.log("  who                            n   carries over   give or take");

  for (const [label, is] of [
    ["a passer who stayed put", (p: { sameTeam: boolean }) => p.sameTeam],
    ["a passer who changed club", (p: { sameTeam: boolean }) => !p.sameTeam],
  ] as [string, (p: { sameTeam: boolean }) => boolean][]) {
    const these = passerMoves.filter(is);

    if (these.length < 8) {
      console.log("  " + label.padEnd(28) + String(these.length).padStart(4) +
        "   too few to say");
      continue;
    }

    console.log(
      "  " + label.padEnd(28) + String(these.length).padStart(4) +
        spearman(these.map((p) => p.was), these.map((p) => p.now))
          .toFixed(3).padStart(15) +
        noise(these.length).toFixed(3).padStart(15),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

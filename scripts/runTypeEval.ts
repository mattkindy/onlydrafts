/**
 * Who decides whether a run goes inside or round the end?
 *
 * Run direction stays with a club when its coordinator leaves, .52,
 * and follows him at a negative number, so it is not his. That leaves
 * the situation, the back carrying it, and the five in front.
 *
 * Run: npx tsx scripts/runTypeEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { splitLine } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadCoaches } from "../src/data/coaches.js";

const SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Carry {
  season: number;
  team: string;
  back: string;
  inside: boolean;
  down: number;
  toGo: number;
  yardline: number;
  yards: number;
}

const share = (of: Carry[]) =>
  of.length ? of.filter((c) => c.inside).length / of.length : undefined;

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const carries: Carry[] = [];

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) {
      continue;
    }

    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        header.forEach((name, i) => { at[name] = i; });
        continue;
      }

      const c = splitLine(line);

      if ((c[at["play_type"]!] ?? "") !== "run") {
        continue;
      }

      const gap = c[at["run_gap"]!] ?? "";
      const where = c[at["run_location"]!] ?? "";
      const back = c[at["rusher_player_id"]!] ?? "";
      const down = Number(c[at["down"]!]);
      const yardline = Number(c[at["yardline_100"]!]);

      if (!back.startsWith("00-") || (!gap && where !== "middle")) {
        continue;
      }

      if (!Number.isFinite(down) || !Number.isFinite(yardline)) {
        continue;
      }

      carries.push({
        season, team: c[at["posteam"]!] ?? "", back,
        inside: where === "middle" || gap === "guard",
        down, toGo: Number(c[at["ydstogo"]!]) || 10, yardline,
        yards: Number(c[at["yards_gained"]!]) || 0,
      });
    }
  }

  console.log(`${carries.length} runs with a direction on them\n`);

  // first the situation, which is the cheapest thing to check
  console.log("how often a run goes inside, by the spot it is called from\n");
  console.log("  situation                    runs   goes inside   and gains");

  const spots: [string, (c: Carry) => boolean][] = [
    ["third or fourth and one", (c) => c.down >= 3 && c.toGo <= 1],
    ["third or fourth, five plus", (c) => c.down >= 3 && c.toGo >= 5],
    ["inside their five", (c) => c.yardline <= 5],
    ["first and ten, open field", (c) =>
      c.down === 1 && c.toGo === 10 && c.yardline > 20 && c.yardline < 80],
    ["backed up inside his ten", (c) => c.yardline >= 90],
  ];

  for (const [label, is] of spots) {
    const these = carries.filter(is);

    if (these.length < 100) {
      continue;
    }

    console.log(
      "  " + label.padEnd(28) + String(these.length).padStart(6) +
        `${(100 * (share(these) ?? 0)).toFixed(1)}%`.padStart(14) +
        middle(these.map((c) => c.yards)).toFixed(2).padStart(12),
    );
  }

  // then the back, held at one club so the line stays put
  const byBack = new Map<string, Map<number, Carry[]>>();

  for (const carry of carries) {
    const his = byBack.get(carry.back) ?? new Map<number, Carry[]>();
    his.set(carry.season, [...(his.get(carry.season) ?? []), carry]);
    byBack.set(carry.back, his);
  }

  interface Moved {
    was: number;
    now: number;
    sameTeam: boolean;
    ocChanged: boolean;
  }

  const moved: Moved[] = [];

  for (const his of byBack.values()) {
    for (const [season, was] of his) {
      const now = his.get(season + 1);

      if (!now || was.length < 40 || now.length < 40) {
        continue;
      }

      const oldTeam = was[0]!.team;
      const newTeam = now[0]!.team;
      const oldOc = coaches.get(`${oldTeam}|${season}|OC`) ?? "";
      const newOc = coaches.get(`${newTeam}|${season + 1}|OC`) ?? "";

      if (!oldOc || !newOc) {
        continue;
      }

      moved.push({
        was: share(was)!, now: share(now)!,
        sameTeam: oldTeam === newTeam, ocChanged: oldOc !== newOc,
      });
    }
  }

  console.log(
    `\nhow often a back goes inside, from one season to the next, ` +
      `${moved.length} of them\n`,
  );
  console.log("  what changed around him        n   carries over   give or take");

  for (const [label, is] of [
    ["nothing", (m: Moved) => m.sameTeam && !m.ocChanged],
    ["the coordinator", (m: Moved) => m.sameTeam && m.ocChanged],
    ["he changed club", (m: Moved) => !m.sameTeam],
  ] as [string, (m: Moved) => boolean][]) {
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
        noise(these.length).toFixed(3).padStart(15),
    );
  }

  // and whether going inside is worth different amounts to different men
  const byMan = new Map<string, Carry[]>();

  for (const carry of carries) {
    byMan.set(carry.back, [...(byMan.get(carry.back) ?? []), carry]);
  }

  const enough = [...byMan.entries()].filter(([, his]) => his.length >= 200);
  const insideShare: number[] = [];
  const gap: number[] = [];

  for (const [, his] of enough) {
    const inside = his.filter((c) => c.inside);
    const outside = his.filter((c) => !c.inside);

    if (inside.length < 50 || outside.length < 50) {
      continue;
    }

    insideShare.push(share(his)!);
    gap.push(
      middle(inside.map((c) => c.yards)) - middle(outside.map((c) => c.yards)),
    );
  }

  console.log(
    `\namong ${gap.length} backs with enough of both kinds\n` +
      `  a run inside is worth ${middle(gap).toFixed(2)} yards more than one outside\n` +
      "  and the men who get more of them are the ones it suits: " +
      spearman(insideShare, gap).toFixed(3),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

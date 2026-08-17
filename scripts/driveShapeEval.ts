/**
 * What a drive simulator has to get right, measured before building
 * it: how often a team runs, what it gains, when it goes for it, and
 * how drives end.
 *
 * Run: npx tsx scripts/driveShapeEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";

interface Play {
  season: number; offense: string; drive: number; week: number;
  down: number; toGo: number; yardline: number; margin: number; seconds: number;
  grouping: string; playType: string; yards: number;
  firstDown: boolean; touchdown: boolean; turnover: boolean;
}

async function main(): Promise<void> {
  const plays: Play[] = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8"),
  ).map((r) => ({
    season: Number(r["season"]), offense: r["offense"] ?? "",
    drive: Number(r["drive"]), week: Number(r["week"]),
    down: Number(r["down"]), toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]), margin: Number(r["margin"]),
    seconds: Number(r["seconds"]), grouping: r["grouping"] ?? "",
    playType: r["playType"] ?? "", yards: Number(r["yards"]),
    firstDown: r["firstDown"] === "1", touchdown: r["touchdown"] === "1",
    turnover: r["turnover"] === "1",
  }));

  const scrimmage = plays.filter((p) => p.playType === "run" || p.playType === "pass");
  console.log(`${plays.length} plays, ${scrimmage.length} from scrimmage\n`);

  // how often a team runs, by down and distance
  console.log("how often it is a run\n");
  console.log("  down    1-2 to go   3-6   7-10   11+");

  for (const down of [1, 2, 3, 4]) {
    const cells = [[1, 2], [3, 6], [7, 10], [11, 99]].map(([low, high]) => {
      const inIt = scrimmage.filter(
        (p) => p.down === down && p.toGo >= low! && p.toGo <= high!,
      );
      return inIt.length < 100
        ? "   -"
        : ((inIt.filter((p) => p.playType === "run").length / inIt.length) * 100)
            .toFixed(0).padStart(4) + "%";
    });
    console.log("  " + String(down).padEnd(8) + cells.join("   "));
  }

  // what a play gains, which is the distribution the walk needs
  console.log("\nwhat a play gains\n");
  console.log("  type    plays   average   loses   0 to 4   5 to 9   10 to 19    20+");

  for (const type of ["run", "pass"]) {
    const inIt = scrimmage.filter((p) => p.playType === type);
    const share = (test: (p: Play) => boolean) =>
      ((inIt.filter(test).length / inIt.length) * 100).toFixed(1).padStart(7) + "%";
    console.log(
      "  " + type.padEnd(8) + String(inIt.length).padStart(6) +
      (inIt.reduce((a, p) => a + p.yards, 0) / inIt.length).toFixed(2).padStart(10) +
      share((p) => p.yards < 0) + share((p) => p.yards >= 0 && p.yards <= 4) +
      share((p) => p.yards >= 5 && p.yards <= 9) +
      share((p) => p.yards >= 10 && p.yards <= 19) + share((p) => p.yards >= 20),
    );
  }

  // what a team does on fourth down, which is where special teams enters
  console.log("\nwhat happens on fourth down\n");
  console.log("  from        punts   kicks   goes for it   plays");

  for (const [label, low, high] of [
    ["own half", 60, 99], ["midfield", 40, 59], ["their 39 to 20", 20, 39],
    ["inside the 20", 1, 19],
  ] as [string, number, number][]) {
    const inIt = plays.filter(
      (p) => p.down === 4 && p.yardline >= low && p.yardline <= high,
    );
    if (inIt.length < 50) continue;
    const share = (type: string) =>
      ((inIt.filter((p) => p.playType === type).length / inIt.length) * 100)
        .toFixed(0).padStart(6) + "%";
    console.log(
      "  " + label.padEnd(16) + share("punt") + share("field_goal") +
      (((inIt.filter((p) => ["run", "pass"].includes(p.playType)).length / inIt.length) * 100)
        .toFixed(0) + "%").padStart(12) + String(inIt.length).padStart(9),
    );
  }

  // and how long a drive is, since that is what links team-mates
  const drives = new Map<string, Play[]>();

  for (const play of scrimmage) {
    const key = `${play.season}|${play.week}|${play.offense}|${play.drive}`;
    drives.set(key, [...(drives.get(key) ?? []), play]);
  }

  const lengths = [...drives.values()].map((d) => d.length).sort((a, b) => a - b);
  const scored = [...drives.values()].filter((d) => d.some((p) => p.touchdown)).length;

  console.log(`\n${drives.size} drives, ${(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1)} plays each`);
  console.log("  a quarter of them run " + lengths[Math.floor(lengths.length * 0.25)] +
    " plays or fewer, a tenth run " + lengths[Math.floor(lengths.length * 0.9)] + " or more");
  console.log("  " + ((scored / drives.size) * 100).toFixed(1) + "% end in a touchdown");
  console.log("\nthat spread is what ties team-mates together: everyone on a");
  console.log("twelve play drive gets touches, and nobody does on a three and out");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

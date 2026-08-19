/**
 * How fast going for it is climbing, so the model can be lifted to
 * where the season it is guessing actually sits.
 *
 * The model punts on 38.8% of drives where sides punt on 35.7%, and
 * loses the ball on downs 3.7% of the time where they lose it 5.8%.
 * Both say it kicks when sides go. It is fitted on the seasons before,
 * and the rate climbs every year.
 *
 * Run: npx tsx scripts/fourthClimbCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  )).filter((r) => Number(r["down"]) === 4);
  const bySeason = new Map<number, { all: number; went: number }>();

  for (const row of rows) {
    const season = Number(row["season"]);
    const own = bySeason.get(season) ?? { all: 0, went: 0 };
    own.all++;
    if (["run", "pass"].includes(row["playType"] ?? "")) own.went++;
    bySeason.set(season, own);
  }

  console.log("how often a side goes for it on fourth down\n");
  const seasons = [...bySeason.keys()].sort();
  let last = 0;

  for (const season of seasons) {
    const own = bySeason.get(season)!;
    const rate = own.went / own.all;
    console.log(
      `  ${season}   ${String(own.all).padStart(5)} fourth downs   ` +
        `${(100 * rate).toFixed(1)}%` +
        (last > 0 ? `   times ${(rate / last).toFixed(3)} on the year before` : ""),
    );
    last = rate;
  }

  // what a model fitted on all but the last would need lifting by
  const learn = seasons.slice(0, -1);
  const target = seasons[seasons.length - 1]!;
  const fittedOn = learn.reduce(
    (sum, s) => sum + bySeason.get(s)!.went, 0,
  ) / learn.reduce((sum, s) => sum + bySeason.get(s)!.all, 0);
  const reallyWas = bySeason.get(target)!.went / bySeason.get(target)!.all;

  console.log(
    `\n  fitted flat over ${learn.join(", ")} it says ` +
      `${(100 * fittedOn).toFixed(1)}%, and ${target} came out at ` +
      `${(100 * reallyWas).toFixed(1)}%\n` +
      `  so it wants lifting by ${(reallyWas / fittedOn).toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

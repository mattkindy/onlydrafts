/**
 * Whether the league got braver or its coaches got replaced.
 *
 * Sides went for it on 37% of fourth and short inside the ten in 2015
 * and 78% in 2025. Two things could do that: the men in charge changed
 * their minds, or the ones who would not were replaced by men who
 * would. Splitting a season's change into the teams that kept their
 * coach and the teams that did not tells them apart.
 *
 * Run: npx tsx scripts/coachAggressionEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { parseCsv, splitLine } from "../src/data/csv.js";

const SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function ratesFor(season: number) {
  const path = join(RAW_DIR, `play_by_play_${season}.csv`);

  if (!existsSync(path)) {
    return new Map<string, { went: number; all: number }>();
  }

  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  const at: Record<string, number> = {};
  const byTeam = new Map<string, { went: number; all: number }>();

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      for (const field of ["down", "ydstogo", "yardline_100", "play_type", "posteam"]) {
        at[field] = header.indexOf(field);
      }
      continue;
    }

    const c = splitLine(line);

    if (Number(c[at["down"]!]) !== 4) {
      continue;
    }

    const type = c[at["play_type"]!] ?? "";
    const team = c[at["posteam"]!] ?? "";

    if (!team || !["run", "pass", "punt", "field_goal"].includes(type)) {
      continue;
    }

    // any fourth down, since one team's short yardage chances are few
    const own = byTeam.get(team) ?? { went: 0, all: 0 };
    own.all++;
    if (["run", "pass"].includes(type)) own.went++;
    byTeam.set(team, own);
  }

  return byTeam;
}

async function main(): Promise<void> {
  const coaches = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "coaches.csv"), "utf8",
  )).filter((r) => r["role"] === "HC");
  const inCharge = new Map<string, string>();

  for (const row of coaches) {
    inCharge.set(`${row["season"]}|${row["team"]}`, row["name"] ?? "");
  }

  const rates = new Map<number, Map<string, { went: number; all: number }>>();

  for (const season of SEASONS) {
    rates.set(season, await ratesFor(season));
  }

  const kept: number[] = [];
  const changed: number[] = [];
  let keptTeams = 0;
  let changedTeams = 0;

  for (let i = 1; i < SEASONS.length; i++) {
    const before = rates.get(SEASONS[i - 1]!)!;
    const now = rates.get(SEASONS[i]!)!;

    for (const [team, own] of now) {
      const was = before.get(team);

      if (!was || was.all < 20 || own.all < 20) {
        continue;
      }

      const wasCoach = inCharge.get(`${SEASONS[i - 1]}|${team}`);
      const nowCoach = inCharge.get(`${SEASONS[i]}|${team}`);

      if (!wasCoach || !nowCoach) {
        continue;
      }

      const moved = own.went / own.all - was.went / was.all;

      if (wasCoach === nowCoach) {
        kept.push(moved);
        keptTeams++;
      } else {
        changed.push(moved);
        changedTeams++;
      }
    }
  }

  console.log(
    `how a team's fourth down rate moved from one season to the next\n` +
      `  where the same man stayed in charge  ` +
      `${(100 * middle(kept)).toFixed(2)} points, over ${keptTeams} team seasons\n` +
      `  where a new man came in              ` +
      `${(100 * middle(changed)).toFixed(2)} points, over ${changedTeams} team seasons`,
  );

  const share = changedTeams / (keptTeams + changedTeams);
  const fromKeeping = middle(kept) * (1 - share);
  const fromChanging = middle(changed) * share;
  console.log(
    `\n  the league moved ${(100 * (fromKeeping + fromChanging)).toFixed(2)} points a ` +
      "season between them" +
      `\n    ${(100 * fromKeeping).toFixed(2)} of it from men who stayed changing their minds` +
      `\n    ${(100 * fromChanging).toFixed(2)} of it from men being replaced`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

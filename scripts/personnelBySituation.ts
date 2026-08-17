/**
 * What an offence lines up in, by the situation it is in.
 *
 * Personnel has been measured on its own so far, which averages over
 * every down and every yard line. A coordinator does not choose the
 * same grouping on third and twelve as he does on the two yard line,
 * and that choice is what decides who is on the field to catch a pass.
 *
 * The participation file has the personnel and no down or distance;
 * the play-by-play has the down and distance and no personnel. They
 * share a game and a play id.
 *
 * Run: npx tsx scripts/personnelBySituation.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { situationOf, type FineSituation } from "../src/model/situations.js";

const SEASON = 2024;

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

const grouping = (text: string): string => {
  const backs = Number(/(\d+) RB/.exec(text)?.[1] ?? NaN);
  const tightEnds = Number(/(\d+) TE/.exec(text)?.[1] ?? NaN);

  if (!Number.isFinite(backs) || !Number.isFinite(tightEnds)) {
    return "?";
  }

  if (backs === 1 && tightEnds === 1) return "11";
  if (backs === 1 && tightEnds === 2) return "12";
  // three or more backs and tight ends between them
  if (backs + tightEnds >= 3) return "heavy";
  return "other";
};

const secondary = (text: string): string => {
  let backs = 0;

  for (const spot of ["CB", "FS", "SS", "S", "DB"]) {
    backs += Number(new RegExp(`(\\d+) ${spot}(?:,|$)`).exec(text)?.[1] ?? 0);
  }

  if (backs < 4) return "?";
  if (backs === 4) return "base";
  if (backs === 5) return "nickel";
  return "dime";
};

async function main(): Promise<void> {
  // every play's situation, from the play-by-play
  const situationOfPlay = new Map<string, FineSituation>();
  const pbp = join(RAW_DIR, `play_by_play_${SEASON}.csv`);

  if (!existsSync(pbp)) {
    throw new Error(`no play-by-play for ${SEASON}`);
  }

  {
    const reader = createInterface({ input: createReadStream(pbp) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        for (const field of [
          "game_id", "play_id", "down", "ydstogo", "yardline_100",
          "score_differential", "game_seconds_remaining", "play_type",
        ]) {
          at[field] = header.indexOf(field);
        }
        continue;
      }

      const c = splitLine(line);
      const type = c[at["play_type"]!] ?? "";
      if (type !== "run" && type !== "pass") continue;

      const down = Number(c[at["down"]!]);
      const yard = Number(c[at["yardline_100"]!]);
      if (!Number.isFinite(down) || !Number.isFinite(yard)) continue;

      situationOfPlay.set(
        `${c[at["game_id"]!]}|${c[at["play_id"]!]}`,
        situationOf(
          down, Number(c[at["ydstogo"]!]) || 10, yard,
          -(Number(c[at["score_differential"]!]) || 0),
          Number(c[at["game_seconds_remaining"]!]) || 1800,
        ),
      );
    }
  }

  console.log(`${situationOfPlay.size} plays with a situation\n`);

  const table = new Map<FineSituation, Map<string, number>>();
  const answer = new Map<string, Map<string, number>>();
  const reader = createInterface({
    input: createReadStream(join(RAW_DIR, `participation_${SEASON}.csv`)),
  });
  let header: string[] | undefined;
  let iGame = -1, iPlay = -1, iOff = -1, iDef = -1;

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      iGame = header.indexOf("nflverse_game_id");
      iPlay = header.indexOf("play_id");
      iOff = header.indexOf("offense_personnel");
      iDef = header.indexOf("defense_personnel");
      continue;
    }

    const c = splitLine(line);
    const situation = situationOfPlay.get(`${c[iGame]}|${c[iPlay]}`);
    const group = grouping(c[iOff] ?? "");
    if (!situation || group === "?" || group === "other") continue;

    const row = table.get(situation) ?? new Map<string, number>();
    row.set(group, (row.get(group) ?? 0) + 1);
    table.set(situation, row);

    const shell = secondary(c[iDef] ?? "");
    if (shell === "?") continue;
    const key = `${situation}|${group}`;
    const reply = answer.get(key) ?? new Map<string, number>();
    reply.set(shell, (reply.get(shell) ?? 0) + 1);
    answer.set(key, reply);
  }

  console.log("what the offence lines up in, by situation\n");
  console.log("situation            plays      11      12   heavy");

  const order: FineSituation[] = [
    "goalLine", "insideTen", "redZone", "thirdAndShort",
    "thirdAndMedium", "thirdAndLong", "earlyDown", "earlyAndLong",
  ];

  for (const situation of order) {
    const row = table.get(situation);
    if (!row) continue;
    const total = [...row.values()].reduce((a, b) => a + b, 0);
    const pct = (k: string) => (((row.get(k) ?? 0) / total) * 100).toFixed(1) + "%";
    console.log(
      situation.padEnd(20) + String(total).padStart(6) +
      pct("11").padStart(8) + pct("12").padStart(8) + pct("heavy").padStart(8),
    );
  }

  console.log("\nand what the defence answers, where it matters most\n");
  console.log("situation, grouping           base   nickel    dime");

  for (const situation of ["goalLine", "thirdAndLong", "earlyDown"] as FineSituation[]) {
    for (const group of ["11", "heavy"]) {
      const reply = answer.get(`${situation}|${group}`);
      if (!reply) continue;
      const total = [...reply.values()].reduce((a, b) => a + b, 0);
      if (total < 100) continue;
      const pct = (k: string) => (((reply.get(k) ?? 0) / total) * 100).toFixed(1) + "%";
      console.log(
        `${situation}, ${group}`.padEnd(30) +
        pct("base").padStart(6) + pct("nickel").padStart(9) + pct("dime").padStart(8),
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Turns the play-by-play into a relation between the situation and
 * what came of it, per player.
 *
 * A season total says a back had thirty carries inside the twenty.
 * That is a marginal, and a simulation cannot use it to answer what
 * happens on third and one while trailing. What it needs is who gets
 * the ball in a situation and what follows, which is what this writes:
 * one row per player, situation and season.
 *
 * Run: npx tsx scripts/aggregateSituations.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { situationOf } from "../src/model/situations.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "situations.csv");

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


/**
 * Kept apart on purpose. Yards per catch and yards per hand-off are
 * different numbers, and a single yards-per-touch applied after a
 * catch rate loses a third of a receiver's yardage.
 */
interface Tally {
  targets: number;
  receptions: number;
  recYds: number;
  carries: number;
  rushYds: number;
  scores: number;
}

async function main(): Promise<void> {
  const rows: string[] = [
    "season,player,team,situation,targets,receptions,recYds," +
      "carries,rushYds,scores,teamPlays",
  ];

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) continue;

    const byPlayer = new Map<string, Tally & { team: string }>();
    const blank = (team: string): Tally & { team: string } => ({
      team, targets: 0, receptions: 0, recYds: 0, carries: 0, rushYds: 0, scores: 0,
    });
    const byTeamSituation = new Map<string, number>();
    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        for (const field of [
          "posteam", "down", "ydstogo", "yardline_100", "score_differential",
          "game_seconds_remaining", "receiver_player_id", "rusher_player_id",
          "touchdown", "td_player_id", "yards_gained", "play_type",
          "complete_pass", "receiving_yards", "rushing_yards",
        ]) {
          at[field] = header.indexOf(field);
        }
        continue;
      }

      const c = splitLine(line);
      const team = c[at["posteam"]!] ?? "";
      const type = c[at["play_type"]!] ?? "";

      if (!team || team === "NA" || (type !== "run" && type !== "pass")) {
        continue;
      }

      const down = Number(c[at["down"]!]);
      const toGo = Number(c[at["ydstogo"]!]);
      const yard = Number(c[at["yardline_100"]!]);
      const behind = -Number(c[at["score_differential"]!]);
      const left = Number(c[at["game_seconds_remaining"]!]);

      if (!Number.isFinite(down) || !Number.isFinite(yard)) continue;

      const situation = situationOf(
        down, toGo, yard,
        Number.isFinite(behind) ? behind : 0,
        Number.isFinite(left) ? left : 1800,
      );
      const teamKey = `${team}|${situation}`;
      byTeamSituation.set(teamKey, (byTeamSituation.get(teamKey) ?? 0) + 1);

      const receiver = c[at["receiver_player_id"]!] ?? "";
      const rusher = c[at["rusher_player_id"]!] ?? "";
      const scorer = c[at["td_player_id"]!] ?? "";
      const gained = Number(c[at["yards_gained"]!]) || 0;

      const scoredHere = c[at["touchdown"]!] === "1";
      const complete = c[at["complete_pass"]!] === "1";

      if (receiver && receiver !== "NA") {
        const key = `${receiver}|${situation}`;
        const tally = byPlayer.get(key) ?? blank(team);
        tally.targets++;

        if (complete) {
          tally.receptions++;
          tally.recYds += Number(c[at["receiving_yards"]!]) || gained;
        }

        if (scoredHere && scorer === receiver) tally.scores++;
        byPlayer.set(key, tally);
      }

      if (rusher && rusher !== "NA") {
        const key = `${rusher}|${situation}`;
        const tally = byPlayer.get(key) ?? blank(team);
        tally.carries++;
        tally.rushYds += Number(c[at["rushing_yards"]!]) || gained;
        if (scoredHere && scorer === rusher) tally.scores++;
        byPlayer.set(key, tally);
      }
    }

    for (const [key, tally] of byPlayer) {
      const [player, situation] = key.split("|");

      if (tally.targets + tally.carries < 3) continue;

      rows.push([
        season, player, tally.team, situation,
        tally.targets, tally.receptions, tally.recYds.toFixed(0),
        tally.carries, tally.rushYds.toFixed(0), tally.scores,
        byTeamSituation.get(`${tally.team}|${situation}`) ?? 0,
      ].join(","));
    }

    console.log(`${season}: ${byPlayer.size} player-situations`);
  }

  await writeFile(OUT, rows.join("\n") + "\n");
  console.log(`wrote ${rows.length - 1} rows to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

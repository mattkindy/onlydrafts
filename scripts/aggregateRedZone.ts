/**
 * Streams the play-by-play for chances to score, and writes them per
 * player and per team.
 *
 * Realised touchdowns are the worst input the generative model takes:
 * a player's share of his team's scores carries over from one season
 * to the next at about zero. Who gets the ball inside the twenty is a
 * decision, repeated weekly, and decisions repeat better than the
 * bounces that follow them.
 *
 * Run: npx tsx scripts/aggregateRedZone.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "redZone.csv");
const RED_ZONE = 20;
const GOAL_LINE = 5;

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

interface Chances {
  team: string;
  redTargets: number;
  redCarries: number;
  goalCarries: number;
  scores: number;
}

async function main(): Promise<void> {
  const rows: string[] = [
    "season,player,team,redTargets,redCarries,goalCarries,scores," +
      "teamRedTargets,teamRedCarries,teamGoalCarries,teamScores",
  ];

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) {
      console.warn(`no play-by-play for ${season}`);
      continue;
    }

    const byPlayer = new Map<string, Chances>();
    const byTeam = new Map<string, Chances>();
    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    let iPos = -1, iYard = -1, iRec = -1, iRush = -1, iTd = -1, iTdPlayer = -1;

    const bump = (
      map: Map<string, Chances>, key: string, team: string,
      field: keyof Omit<Chances, "team">,
    ) => {
      const entry = map.get(key) ??
        { team, redTargets: 0, redCarries: 0, goalCarries: 0, scores: 0 };
      entry[field]++;
      map.set(key, entry);
    };

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        iPos = header.indexOf("posteam");
        iYard = header.indexOf("yardline_100");
        iRec = header.indexOf("receiver_player_id");
        iRush = header.indexOf("rusher_player_id");
        iTd = header.indexOf("touchdown");
        iTdPlayer = header.indexOf("td_player_id");
        continue;
      }

      const cells = splitLine(line);
      const team = cells[iPos] ?? "";
      const yard = Number(cells[iYard]);

      if (!team || team === "NA" || !Number.isFinite(yard)) {
        continue;
      }

      const scorer = cells[iTdPlayer] ?? "";

      if (cells[iTd] === "1" && scorer && scorer !== "NA") {
        bump(byPlayer, scorer, team, "scores");
        bump(byTeam, team, team, "scores");
      }

      if (yard > RED_ZONE) {
        continue;
      }

      const receiver = cells[iRec] ?? "";
      const rusher = cells[iRush] ?? "";

      if (receiver && receiver !== "NA") {
        bump(byPlayer, receiver, team, "redTargets");
        bump(byTeam, team, team, "redTargets");
      }

      if (rusher && rusher !== "NA") {
        bump(byPlayer, rusher, team, "redCarries");
        bump(byTeam, team, team, "redCarries");

        if (yard <= GOAL_LINE) {
          bump(byPlayer, rusher, team, "goalCarries");
          bump(byTeam, team, team, "goalCarries");
        }
      }
    }

    for (const [player, c] of byPlayer) {
      const team = byTeam.get(c.team);

      if (!team || c.redTargets + c.redCarries + c.scores === 0) {
        continue;
      }

      rows.push([
        season, player, c.team, c.redTargets, c.redCarries, c.goalCarries, c.scores,
        team.redTargets, team.redCarries, team.goalCarries, team.scores,
      ].join(","));
    }

    console.log(`${season}: ${byPlayer.size} players`);
  }

  await writeFile(OUT, rows.join("\n") + "\n");
  console.log(`wrote ${rows.length - 1} rows to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

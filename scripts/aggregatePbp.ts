// Streams the play-by-play files and writes per team-season tendency
// aggregates to data/curated/teamTendencies.csv.
// Run: npx tsx scripts/aggregatePbp.ts

import { createReadStream, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";

const SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "teamTendencies.csv");

/** splits one csv line, honoring double quotes; embedded newlines lose the row */
function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }

  cells.push(cell);
  return cells;
}

interface Tendency {
  plays: number;
  passes: number;
  neutralPlays: number;
  neutralPasses: number;
  games: Set<string>;
}

async function aggregateSeason(
  season: number,
  into: Map<string, Tendency>,
): Promise<void> {
  const path = join(RAW_DIR, `play_by_play_${season}.csv`);

  if (!existsSync(path)) {
    console.log(`missing ${path}, skipping`);
    return;
  }

  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });

  let header: Map<string, number> | undefined;
  let expected = 0;

  for await (const line of lines) {
    const cells = splitLine(line);

    if (!header) {
      header = new Map(cells.map((name, i) => [name, i]));
      expected = cells.length;
      continue;
    }

    if (cells.length !== expected) {
      continue;
    }

    const at = (name: string) => cells[header!.get(name) ?? -1] ?? "";

    if (at("season_type") !== "REG") {
      continue;
    }

    const playType = at("play_type");

    if (playType !== "pass" && playType !== "run") {
      continue;
    }

    const team = at("posteam");

    if (!team) {
      continue;
    }

    const key = `${team}|${season}`;
    const entry =
      into.get(key) ??
      ({ plays: 0, passes: 0, neutralPlays: 0, neutralPasses: 0, games: new Set() } as Tendency);
    const isPass = playType === "pass";
    const diff = Number(at("score_differential"));
    const quarter = Number(at("qtr"));
    const neutral =
      Number.isFinite(diff) && Math.abs(diff) <= 7 && quarter >= 1 && quarter <= 3;

    entry.plays++;
    entry.games.add(at("game_id"));

    if (isPass) {
      entry.passes++;
    }

    if (neutral) {
      entry.neutralPlays++;

      if (isPass) {
        entry.neutralPasses++;
      }
    }

    into.set(key, entry);
  }

  console.log(`${season} aggregated`);
}

async function main(): Promise<void> {
  const tendencies = new Map<string, Tendency>();

  for (const season of SEASONS) {
    await aggregateSeason(season, tendencies);
  }

  const rows = ["team,season,plays,games,passRate,neutralPassRate"];

  for (const [key, t] of tendencies) {
    const [team, season] = key.split("|");
    rows.push(
      [
        team,
        season,
        t.plays,
        t.games.size,
        (t.passes / t.plays).toFixed(4),
        t.neutralPlays > 0 ? (t.neutralPasses / t.neutralPlays).toFixed(4) : "",
      ].join(","),
    );
  }

  writeFileSync(OUT, rows.join("\n") + "\n");
  console.log(`${rows.length - 1} team seasons written`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

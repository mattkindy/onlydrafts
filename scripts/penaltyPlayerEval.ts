/**
 * Whether being flagged is something a man does or something that
 * happens to a team.
 *
 * The walk fits penalties per offence, so a defence that interferes
 * every week is credited to whoever it played. If the habit belongs to
 * the man, it follows him when he moves, and the board could take it
 * with him the way it already does a pass rusher's sacks.
 *
 * Who drew the flag is not in this data: interference comes on an
 * incomplete pass, where receiver_player_id is empty.
 *
 * Run: npx tsx scripts/penaltyPlayerEval.ts
 */

import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { parseCsv, splitLine } from "../src/data/csv.js";

const PAIRS = [
  [2021, 2022], [2022, 2023], [2023, 2024], [2024, 2025],
] as const;
const SEASONS = [2021, 2022, 2023, 2024, 2025];

/** the flags a man can fairly be said to have earned himself */
const HIS_OWN = new Set([
  "Defensive Pass Interference", "Defensive Holding", "Illegal Contact",
  "Offensive Holding", "False Start", "Roughing the Passer",
  "Unnecessary Roughness", "Face Mask", "Illegal Use of Hands",
  "Offensive Pass Interference", "Illegal Block Above the Waist",
]);

const normalize = (name: string) =>
  name.toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?$/, "")
    .replace(/[^a-z]/g, "");

const mean = (its: number[]) =>
  its.length ? its.reduce((s, n) => s + n, 0) / its.length : 0;

function correlation(pairs: [number, number][]): number {
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const mx = mean(xs);
  const my = mean(ys);
  const top = pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const left = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const right = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));

  return left && right ? top / (left * right) : 0;
}

interface Season {
  /** flags thrown against him */
  committed: Map<string, number>;
  /** interference and holding thrown for him, which he does not score */
  drawn: Map<string, number>;
  /** and the yards those handed his side */
  drawnYards: Map<string, number>;
}

/**
 * The play by play is a hundred megabytes a season and this wants nine
 * of its columns, so it goes a line at a time rather than into memory.
 */
async function readSeason(season: number): Promise<Season> {
  const its: Season = {
    committed: new Map(), drawn: new Map(), drawnYards: new Map(),
  };
  const lines = createInterface({
    input: createReadStream(`data/raw/play_by_play_${season}.csv`),
    crlfDelay: Infinity,
  });
  let head: string[] | null = null;
  let at: Record<string, number> = {};

  for await (const line of lines) {
    if (!head) {
      head = splitLine(line);
      at = Object.fromEntries(head.map((name, i) => [name, i]));
      continue;
    }

    const cells = splitLine(line);
    const type = cells[at["penalty_type"]!] ?? "";

    if (!type || !HIS_OWN.has(type)) {
      continue;
    }

    // by id rather than by name, since the play by play abbreviates a
    // man to his initial and nothing else does
    const who = cells[at["penalty_player_id"]!] ?? "";

    if (who) {
      its.committed.set(who, (its.committed.get(who) ?? 0) + 1);
    }

    // a flag thrown at a defender on a pass is one the receiver drew,
    // and the yards go to his side without touching his own line
    const drawnBy = ["Defensive Pass Interference", "Defensive Holding",
      "Illegal Contact"].includes(type)
      ? cells[at["receiver_player_id"]!] ?? ""
      : "";

    if (drawnBy) {
      its.drawn.set(drawnBy, (its.drawn.get(drawnBy) ?? 0) + 1);
      its.drawnYards.set(
        drawnBy,
        (its.drawnYards.get(drawnBy) ?? 0) +
          (Number(cells[at["penalty_yards"]!]) || 0),
      );
    }
  }

  return its;
}

/**
 * How many games each man played, keyed the way the play by play keys
 * him, so a rate can be taken and the two files can be joined at all.
 */
function playedIn(season: number) {
  const rows = parseCsv(
    readFileSync(`data/raw/stats_player_week_${season}.csv`, "utf8"),
  );
  const games = new Map<string, number>();

  for (const row of rows) {
    const who = row["player_id"] ?? "";

    if (who && Number(row["week"]) <= 18) {
      games.set(who, (games.get(who) ?? 0) + 1);
    }
  }

  return games;
}

/** who each id is, for printing a list a person can read */
function namesIn(season: number) {
  const rows = parseCsv(
    readFileSync(`data/raw/stats_player_week_${season}.csv`, "utf8"),
  );
  const called = new Map<string, string>();

  for (const row of rows) {
    const who = row["player_id"] ?? "";

    if (who && !called.has(who)) {
      called.set(who, row["player_display_name"] ?? who);
    }
  }

  return called;
}

const seasons = new Map<number, Season>();
const played = new Map<number, Map<string, number>>();
const called = new Map<string, string>();

for (const season of SEASONS) {
  seasons.set(season, await readSeason(season));
  played.set(season, playedIn(season));

  for (const [id, name] of namesIn(season)) {
    called.set(id, name);
  }

  process.stdout.write(`read ${season}\n`);
}

/** below this a rate says more about his health than his habits */
const ENOUGH = 15;

console.log("\nhow much of a man's flag rate is still there next season\n");

for (const [what, of] of [
  ["flags thrown against him", (s: Season) => s.committed],
  ["interference he drew", (s: Season) => s.drawn],
] as [string, (s: Season) => Map<string, number>][]) {
  const pairs: [number, number][] = [];

  for (const [was, now] of PAIRS) {
    const before = played.get(was)!;
    const after = played.get(now)!;

    for (const [who, games] of before) {
      const then = after.get(who) ?? 0;

      if (games < ENOUGH || then < ENOUGH) {
        continue;
      }

      pairs.push([
        (of(seasons.get(was)!).get(who) ?? 0) / games,
        (of(seasons.get(now)!).get(who) ?? 0) / then,
      ]);
    }
  }

  console.log(
    `  ${what.padEnd(26)} ${correlation(pairs).toFixed(3).padStart(7)}` +
    `   (${pairs.length} pairs)`,
  );
}

console.log("\nthe men who drew the most interference, and what it was worth\n");

const drew = new Map<string, { flags: number; yards: number }>();

for (const season of SEASONS) {
  for (const [who, n] of seasons.get(season)!.drawn) {
    const so = drew.get(who) ?? { flags: 0, yards: 0 };
    so.flags += n;
    so.yards += seasons.get(season)!.drawnYards.get(who) ?? 0;
    drew.set(who, so);
  }
}

const top = [...drew].sort((a, b) => b[1].yards - a[1].yards).slice(0, 12);

for (const [who, so] of top) {
  console.log(
    `  ${(called.get(who) ?? who).padEnd(22)} ${String(so.flags).padStart(3)} flags` +
    ` ${String(so.yards).padStart(4)} yards over five seasons` +
    `  ${(so.yards / 5).toFixed(0)} a season`,
  );
}

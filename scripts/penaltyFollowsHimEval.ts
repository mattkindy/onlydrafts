/**
 * Whether a flag habit is worth taking with the man when he moves.
 *
 * That a man's rate repeats says the habit is his. It does not say the
 * board gains anything by moving it, since a side keeps most of its
 * players and its own last season already knows what they do. So this
 * forecasts a defence's flags two ways: off the team, and off the men
 * who will be playing for it.
 *
 * Run: npx tsx scripts/penaltyFollowsHimEval.ts
 */

import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { parseCsv, splitLine } from "../src/data/csv.js";

const PAIRS = [
  [2021, 2022], [2022, 2023], [2023, 2024], [2024, 2025],
] as const;
const SEASONS = [2021, 2022, 2023, 2024, 2025];

/** the flags a defender is fairly said to have earned himself */
const HIS_OWN = new Set([
  "Defensive Pass Interference", "Defensive Holding", "Illegal Contact",
  "Roughing the Passer", "Unnecessary Roughness", "Face Mask",
  "Illegal Use of Hands",
]);

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

interface Flags {
  /** by the man who was flagged */
  byMan: Map<string, number>;
  /** and by the side he was playing for */
  byTeam: Map<string, number>;
}

async function readSeason(season: number): Promise<Flags> {
  const its: Flags = { byMan: new Map(), byTeam: new Map() };
  const lines = createInterface({
    input: createReadStream(`data/raw/play_by_play_${season}.csv`),
    crlfDelay: Infinity,
  });
  let at: Record<string, number> | null = null;

  for await (const line of lines) {
    const cells = splitLine(line);

    if (!at) {
      at = Object.fromEntries(cells.map((name, i) => [name, i]));
      continue;
    }

    if (!HIS_OWN.has(cells[at["penalty_type"]!] ?? "")) {
      continue;
    }

    const who = cells[at["penalty_player_id"]!] ?? "";
    const side = cells[at["penalty_team"]!] ?? "";

    if (who) {
      its.byMan.set(who, (its.byMan.get(who) ?? 0) + 1);
    }

    if (side) {
      its.byTeam.set(side, (its.byTeam.get(side) ?? 0) + 1);
    }
  }

  return its;
}

/** how many games each man played, keyed as the play by play keys him */
function playedIn(season: number) {
  const games = new Map<string, number>();

  for (const row of parseCsv(
    readFileSync(`data/raw/stats_player_week_${season}.csv`, "utf8"),
  )) {
    const who = row["player_id"] ?? "";

    if (who && Number(row["week"]) <= 18) {
      games.set(who, (games.get(who) ?? 0) + 1);
    }
  }

  return games;
}

/** who is on each side this season, by the same key */
function squadsIn(season: number) {
  const squads = new Map<string, string[]>();

  for (const row of parseCsv(
    readFileSync(`data/raw/roster_weekly_${season}.csv`, "utf8"),
  )) {
    const team = row["team"] ?? "";
    const who = row["gsis_id"] ?? "";

    if (!team || !who) {
      continue;
    }

    const its = squads.get(team) ?? [];

    if (!its.includes(who)) {
      its.push(who);
    }

    squads.set(team, its);
  }

  return squads;
}

const flags = new Map<number, Flags>();
const played = new Map<number, Map<string, number>>();
const squads = new Map<number, Map<string, string[]>>();

for (const season of SEASONS) {
  flags.set(season, await readSeason(season));
  played.set(season, playedIn(season));
  squads.set(season, squadsIn(season));
  process.stdout.write(`read ${season}\n`);
}

const fromTeam: [number, number][] = [];
const fromMen: [number, number][] = [];
const fromCounts: [number, number][] = [];
const fromBoth: [number, number][] = [];

for (const [was, now] of PAIRS) {
  const before = flags.get(was)!;
  const after = flags.get(now)!;
  const beforeGames = played.get(was)!;

  for (const [team, squad] of squads.get(now)!) {
    const then = after.byTeam.get(team);

    if (then === undefined) {
      continue;
    }

    /**
     * What the men on this side did last season, wherever they did it.
     * A rate a game each, added up over the squad, which is what the
     * build already does for a pass rusher's sacks.
     */
    const theirs = squad.reduce((sum, who) => {
      const games = beforeGames.get(who) ?? 0;

      return games >= 6
        ? sum + (before.byMan.get(who) ?? 0) / games
        : sum;
    }, 0);

    /**
     * The same men, counted rather than rated. Adding raw counts weighs
     * a man by how much he played, so a starting corner counts for more
     * than a backup who was flagged twice in six games, which is what
     * the build already does with a pass rusher's sacks.
     */
    const counted = squad.reduce(
      (sum, who) => sum + (before.byMan.get(who) ?? 0), 0,
    );
    const ours = before.byTeam.get(team) ?? 0;

    fromTeam.push([ours, then]);
    fromMen.push([theirs, then]);
    fromCounts.push([counted, then]);
    fromBoth.push([ours / 17 + theirs, then]);
  }
}

console.log("\nforecasting a side's flags next season\n");
console.log(
  `  its own last season      ${correlation(fromTeam).toFixed(3).padStart(7)}` +
  `   (${fromTeam.length} teams)`,
);
console.log(
  `  the men, by their rates  ${correlation(fromMen).toFixed(3).padStart(7)}`,
);
console.log(
  `  both together            ${correlation(fromBoth).toFixed(3).padStart(7)}`,
);
console.log(
  `  the men, counted up      ${correlation(fromCounts).toFixed(3).padStart(7)}`,
);

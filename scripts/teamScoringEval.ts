/**
 * Where does a team's scoring error come from?
 *
 * A side's points are drives times points a drive, and a drive is
 * plays times yards a play times how often it finishes. The margin
 * bench says the walk is 1.8 points behind the market and says
 * nothing about which of those is off, so this scores each against
 * what the same fixtures really did, per team per season.
 *
 * Run: npx tsx scripts/teamScoringEval.ts [season]
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { RAW_DIR, loadPlayerStats } from "../src/data/nflverse.js";
import { splitLine, parseCsv } from "../src/data/csv.js";
import { buildWorld } from "../src/features/playedWorld.js";
import { playGame, type Side } from "../src/model/gameFromDrives.js";
import { seededRng } from "../src/sim/rng.js";
import { spearman, rmse } from "../src/backtest/metrics.js";

const SEASON = Number(process.argv[2] ?? 2024);
const RUNS = Number(process.env["RUNS"] ?? 12);

interface Tally {
  drives: number;
  points: number;
  plays: number;
  yards: number;
  games: number;
}

const empty = (): Tally =>
  ({ drives: 0, points: 0, plays: 0, yards: 0, games: 0 });

/** what each side really did, from the play by play */
const played = new Map<string, Tally>();
const reader = createInterface({
  input: createReadStream(join(RAW_DIR, `play_by_play_${SEASON}.csv`)),
});
let header: string[] | undefined;
const at: Record<string, number> = {};
let drive = "";
const gamesOf = new Map<string, Set<string>>();

for await (const line of reader) {
  if (!header) {
    header = splitLine(line);

    for (const f of [
      "game_id", "drive", "season_type", "posteam", "play_type",
      "yards_gained", "fixed_drive_result",
    ]) {
      at[f] = header.indexOf(f);
    }

    continue;
  }

  const c = splitLine(line);

  if (c[at["season_type"]!] !== "REG" || !c[at["posteam"]!]) {
    continue;
  }

  const team = c[at["posteam"]!]!;
  const own = played.get(team) ?? empty();
  const key = `${c[at["game_id"]!]}|${c[at["drive"]!]}`;
  const seen = gamesOf.get(team) ?? new Set<string>();
  seen.add(c[at["game_id"]!]!);
  gamesOf.set(team, seen);

  if (key !== drive) {
    drive = key;
    own.drives++;
    const ended = c[at["fixed_drive_result"]!];
    own.points += ended === "Touchdown" ? 7 : ended === "Field goal" ? 3 : 0;
  }

  const type = c[at["play_type"]!];

  if (type === "run" || type === "pass") {
    own.plays++;
    own.yards += Number(c[at["yards_gained"]!]) || 0;
  }

  played.set(team, own);
}

for (const [team, own] of played) {
  own.games = gamesOf.get(team)?.size ?? 17;
}

/** and what the walk does over the same fixtures */
const positions = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}

const world = await buildWorld(SEASON, 1, false, positions);
const fixtures = parseCsv(await readFile(
  join(RAW_DIR, "games.csv"), "utf8",
)).filter((r) =>
  Number(r["season"]) === SEASON && r["game_type"] === "REG");
const walked = new Map<string, Tally>();

for (const r of fixtures) {
  const home = world.sideFor(r["home_team"]!) as Side | null;
  const away = world.sideFor(r["away_team"]!) as Side | null;

  if (!home || !away) {
    continue;
  }

  for (let run = 0; run < RUNS; run++) {
    const game = playGame(home, away, {
      rules: { ...world.rules, kickSucceeds: world.kicking.kickSucceeds },
      fourth: world.fourth,
      clock: {
        isLast: world.kicking.isLast, lastLength: world.kicking.lastLength,
      },
      ticking: world.ticking, season: SEASON, week: Number(r["week"]),
    }, seededRng(SEASON + run * 7919 + Number(r["week"]) * 37));

    for (const side of [home, away]) {
      const own = walked.get(side.team) ?? empty();
      own.games += 1 / RUNS;

      for (const p of game.possessions) {
        if (p.team !== side.team) {
          continue;
        }

        own.drives += 1 / RUNS;
        own.points +=
          (p.drive.ending === "touchdown" ? 7
            : p.drive.ending === "fieldGoal" ? 3 : 0) / RUNS;
        own.plays += p.drive.plays.length / RUNS;

        for (const play of p.drive.plays) {
          own.yards += play.yards / RUNS;
        }
      }

      walked.set(side.team, own);
    }
  }
}

const teams = [...played.keys()].filter((t) => walked.has(t));
const show = (
  label: string, of: (t: Tally) => number, target: (t: Tally) => number,
) => {
  const mine = teams.map((t) => of(walked.get(t)!));
  const real = teams.map((t) => target(played.get(t)!));
  const middle = (of: number[]) => of.reduce((a, b) => a + b, 0) / of.length;
  console.log(
    `${label.padEnd(22)} walk ${middle(mine).toFixed(2)}  played ` +
    `${middle(real).toFixed(2)}  orders ${spearman(mine, real).toFixed(3)}  ` +
    `off by ${rmse(mine, real).toFixed(2)}`,
  );
};

console.log(`${SEASON}, ${teams.length} sides, ${RUNS} runs a fixture:`);
show("points a game", (t) => t.points / t.games, (t) => t.points / t.games);
show("drives a game", (t) => t.drives / t.games, (t) => t.drives / t.games);
show("points a drive", (t) => t.points / t.drives, (t) => t.points / t.drives);
show("plays a drive", (t) => t.plays / t.drives, (t) => t.plays / t.drives);
show("yards a play", (t) => t.yards / t.plays, (t) => t.yards / t.plays);

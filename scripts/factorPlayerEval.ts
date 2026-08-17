/**
 * What the factor model does for the thing a board is built on.
 *
 * The drives are better shaped. The question is whether a player's
 * season comes out better, since that is what the board ranks and
 * everything else is upstream of it.
 *
 * Run: npx tsx scripts/factorPlayerEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import { walkDrive, CLOCK_DEFAULTS } from "../src/model/driveFromFactors.js";
import type { Call } from "../src/model/playFactors.js";

const RULES = presets.standard;
const SCORE_ON = 2025;
const DRIVES_A_GAME = 11;
const GAMES = 400;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).map((r) => ({
    season: Number(r["season"]),
    down: Number(r["down"]), toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]), call: (r["playType"] ?? "") as Call,
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
    yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
    player: r["player"] ?? "", team: r["offense"] ?? "",
  }));

  const learn = rows.filter((r) => r.season < SCORE_ON);
  const factors = fitPlayFactors(learn as PlayRow[]);
  const rules = await fitDriveRules([2021, 2022, 2023, 2024]);

  // each team's men, from the season before the one being guessed at
  const roster = new Map<string, Set<string>>();

  for (const row of rows.filter((r) => r.season === SCORE_ON - 1)) {
    if (!row.player) continue;
    const own = roster.get(row.team) ?? new Set<string>();
    own.add(row.player);
    roster.set(row.team, own);
  }

  const position = new Map<string, string>();
  const scored = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    position.set(s.playerId, s.position);
    scored.set(
      s.playerId, (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const rng = seededRng(13);
  const normal = () => normalDraw(rng);
  const said = new Map<string, number>();

  for (const [team, men] of roster) {
    const among = [...men].filter((p) => position.has(p));

    if (among.length < 4) {
      continue;
    }

    const got = new Map<string, number>();

    for (let game = 0; game < GAMES; game++) {
      for (let i = 0; i < DRIVES_A_GAME; i++) {
        const startAt = Math.max(35, Math.min(99, Math.round(75 + normal() * 13)));
        const drive = walkDrive(
          startAt, factors, rules, among, rng, CLOCK_DEFAULTS,
        );

        for (const play of drive.plays) {
          if (!play.player) continue;
          const points = play.yards * RULES.rushYds +
            (play.scored ? RULES.rushTd : 0);
          got.set(play.player, (got.get(play.player) ?? 0) + points);
        }
      }
    }

    for (const [player, points] of got) said.set(player, points / GAMES);
  }

  const men = [...said].filter(([player]) => scored.has(player));
  console.log(`${men.length} men projected\n`);

  const truth = men.map(([player]) => scored.get(player)! / 17);
  const guess = men.map(([, points]) => points);
  console.log(
    "a man's points a game, from the factors" +
      `\n  rank ${spearman(guess, truth).toFixed(4)}` +
      `   error ${rmse(guess, truth).toFixed(2)}` +
      `\n  it says ${middle(guess).toFixed(2)} a game where they scored ` +
      `${middle(truth).toFixed(2)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

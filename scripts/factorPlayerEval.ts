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
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import { fitTargetDepth } from "../src/features/targetDepth.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { walkDrive } from "../src/model/driveFromFactors.js";
import { fitFourthDown, type FourthRow } from "../src/features/fitFourthDown.js";
import { loadDriveStarts, startFrom } from "../src/features/driveStarts.js";
import { fitEndings } from "../src/features/fitEndings.js";
import { fitTurnovers, type TurnoverRow } from "../src/features/fitTurnovers.js";
import { divideAmong } from "../src/features/shareCompetition.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import type { Call } from "../src/model/playFactors.js";

const RULES = presets.standard;
const SCORE_ON = 2025;
const DRIVES_A_GAME = 11;
const GAMES = 400;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);


/** what sides really did on fourth down, before the season being tested */
async function fourthDowns(before: number) {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  )).filter((r) => Number(r["season"]) < before && Number(r["down"]) === 4);

  return fitFourthDown(rows.map((r) => ({
    toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
    choice: ["run", "pass"].includes(r["playType"] ?? "") ? "go"
      : r["playType"] === "field_goal" ? "kick" : "punt",
  })) as FourthRow[]);
}

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).map((r) => ({
    season: Number(r["season"]),
    down: Number(r["down"]), toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]), call: (r["playType"] ?? "") as Call,
    offence: r["offense"] ?? "", defence: r["defense"] ?? "",
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
    yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
    player: r["player"] ?? "", team: r["offense"] ?? "",
    passer: r["passer"] ?? "",
    airYards: r["airYards"] === "" || r["airYards"] === undefined
      ? undefined : Number(r["airYards"]),
  }));

  const learn = rows.filter((r) => r.season < SCORE_ON);
  const rules = await fitDriveRules([2021, 2022, 2023, 2024]);
  const fourth = await fourthDowns(SCORE_ON);
  const starts = await loadDriveStarts([2022, 2023, 2024]);
  // the kick and the clock, off the plays rather than written down
  const endings = await fitEndings([2021, 2022, 2023, 2024]);
  const withEndings = { ...rules, kickSucceeds: endings.kickSucceeds };
  const clock = { isLast: endings.isLast, lastLength: endings.lastLength };

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

  /**
   * Each man's expected share of his offence, from the competition
   * model: a position group's work divided among whoever is there, by
   * what each has shown, with a rookie counting for what his round
   * usually brings.
   */
  const lastSeason = new Map<string, number>();
  const teamPlays = new Map<string, number>();

  for (const row of rows.filter((r) => r.season === SCORE_ON - 1)) {
    teamPlays.set(row.team, (teamPlays.get(row.team) ?? 0) + 1);
    if (row.player) {
      lastSeason.set(row.player, (lastSeason.get(row.player) ?? 0) + 1);
    }
  }

  const picks = await loadDraftPicks();
  const rookieShare: Record<string, number> = { RB: 0.09, WR: 0.06, TE: 0.03 };
  const groupTotal: Record<string, number> = { RB: 0.31, WR: 0.33, TE: 0.11 };
  const projected = new Map<string, number>();

  for (const [team, men] of roster) {
    for (const spot of ["RB", "WR", "TE"]) {
      const group = [...men].filter((p) => position.get(p) === spot);

      if (!group.length) {
        continue;
      }

      const shares = divideAmong(
        group.map((player) => {
          const had = lastSeason.get(player) ?? 0;
          const standing = had > 0
            ? had / Math.max(1, teamPlays.get(team) ?? 1000)
            : picks.has(player) ? rookieShare[spot]! : 0.005;
          return { playerId: player, standing };
        }),
        groupTotal[spot]!,
      );

      for (const [player, share] of shares) projected.set(player, share);
    }
  }

  const rng = seededRng(13);
  const said = new Map<string, number>();
  const both: Record<string, Map<string, number>> = {
    "who touched it before": new Map(),
    "the competition model": new Map(),
    "and drawn at his own depth": new Map(),
  };
  const depth = fitTargetDepth(learn as PlayRow[]);

  for (const [label, into] of Object.entries(both)) {
    const factors = fitPlayFactors(learn as PlayRow[], undefined, {
      projected: label === "who touched it before" ? undefined : projected,
      depth: label === "and drawn at his own depth" ? depth : undefined,
    });

    for (const [, men] of roster) {
      const among = [...men].filter((p) => position.has(p));

      if (among.length < 4) {
        continue;
      }

      const got = new Map<string, number>();

      for (let game = 0; game < GAMES; game++) {
        for (let i = 0; i < DRIVES_A_GAME; i++) {
          const startAt = startFrom(starts, rng);
          const drive = walkDrive(
            startAt, factors, withEndings, fourth, among, rng, clock,
          );

          for (const play of drive.plays) {
            if (!play.player) continue;
            const points = play.yards * RULES.rushYds +
              (play.scored ? RULES.rushTd : 0);
            got.set(play.player, (got.get(play.player) ?? 0) + points);
          }
        }
      }

      for (const [player, points] of got) into.set(player, points / GAMES);
    }
  }

  for (const [player, points] of both["who touched it before"]!) {
    said.set(player, points);
  }

  const men = [...said].filter(([player]) => scored.has(player));
  const truth = men.map(([player]) => scored.get(player)! / 17);
  console.log(`${men.length} men projected\n`);
  console.log("who the work goes to        rank    error   says   really");

  for (const [label, from] of Object.entries(both)) {
    const guess = men.map(([player]) => from.get(player) ?? 0);
    console.log(
      "  " + label.padEnd(28) + spearman(guess, truth).toFixed(4).padStart(6) +
      rmse(guess, truth).toFixed(2).padStart(8) +
      middle(guess).toFixed(2).padStart(7) +
      middle(truth).toFixed(2).padStart(9),
    );
  }

  /**
   * And against the market, on the men it priced.
   *
   * The board mixes places from the season regression, the share model
   * and adp. If the walk can stand in that mix, the board comes out of
   * the simulation rather than beside it.
   */
  // only the point-a-catch mocks go back this far, and the question
  // here is whether the walk adds anything to a market, not which
  // market it is
  const adp = await loadAdp(SCORE_ON, "ppr").catch(() => new Map());
  const names = new Map<string, string>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    names.set(s.playerId, s.playerName);
  }

  const priced = men
    .map(([player]) => ({
      player,
      adp: adp.get(
        `${normalizeName(names.get(player) ?? "")}|${position.get(player) ?? ""}`,
      )?.adp ?? null,
      points: (scored.get(player) ?? 0) / 17,
    }))
    .filter((row) => row.adp !== null);

  if (priced.length < 30) {
    console.log("\ntoo few men matched to adp to say anything");
    return;
  }

  const place = (values: number[]) => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const out = new Array<number>(values.length);
    order.forEach((row, rank) => { out[row.i] = rank + 1; });
    return out;
  };
  const pricedTruth = priced.map((row) => row.points);
  const byAdp = place(priced.map((row) => -row.adp!));
  const walked = place(priced.map((row) =>
    both["and drawn at his own depth"]!.get(row.player) ?? 0));

  console.log(`\nagainst adp, on the ${priced.length} men it priced\n`);
  console.log(
    "  where adp had him            " +
      spearman(byAdp.map((r) => -r), pricedTruth).toFixed(4),
  );
  console.log(
    "  the walk                     " +
      spearman(walked.map((r) => -r), pricedTruth).toFixed(4),
  );
  console.log("\n  leaning on the walk by   together");

  for (const lean of [0.25, 0.375, 0.5, 0.625, 0.75]) {
    const mixed = walked.map((w, i) => -(lean * w + (1 - lean) * byAdp[i]!));
    console.log(
      `    ${(100 * lean).toFixed(0)}%`.padEnd(28) +
        spearman(mixed, pricedTruth).toFixed(4),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

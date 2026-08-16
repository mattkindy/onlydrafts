/**
 * The three models side by side, fitted on one season and scored on
 * the next: the flat one the site still serves, the pooled generative
 * one, and the situational one.
 *
 * Run: npx tsx scripts/threeWayEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { buildResidualModel, outcomeQuantile } from "../src/backtest/intervals.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { simulateTeamWeek, type Draws, type PlayerRole } from "../src/model/playerWeek.js";
import {
  LEAGUE_PLAYS, SITUATIONS, simulateSituationalWeek,
  type Situation, type SituationalRole,
} from "../src/model/situationalWeek.js";
import {
  ROLLS_UP_TO, zeroBySituation as zero, type FineSituation,
} from "../src/model/situations.js";
import { simulateSeason, DEFAULT_SEASON } from "../src/model/seasonSim.js";

const RULES = presets.standard;
const FIT_ON = 2024;
const SCORE_ON = 2025;
const RUNS = 3000;

/** the csv's situation names, mapped onto the four the model keeps */




async function fitRoles(season: number) {
  const rows = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "situations.csv"), "utf8"),
  ).filter((r) => Number(r["season"]) === season);

  const players = new Map<string, {
    team: string; position: string;
    touches: Record<Situation, number>;
    scores: Record<Situation, number>;
    yards: Record<Situation, number>;
  }>();
  const teamPlays = new Map<string, Record<Situation, number>>();
  const perSituation = new Map<string, Map<string, number>>();
  const positions = new Map<string, string>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(season)) {
    positions.set(s.playerId, s.position);
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  for (const row of rows) {
    const to = ROLLS_UP_TO[(row["situation"] ?? "") as FineSituation];
    const id = row["player"] ?? "";
    const team = row["team"] ?? "";
    if (!to || !["RB", "WR", "TE"].includes(positions.get(id) ?? "")) continue;

    const entry = players.get(id) ??
      { team, position: positions.get(id)!, touches: zero(), scores: zero(), yards: zero() };
    entry.touches[to] += Number(row["touches"]);
    entry.scores[to] += Number(row["scores"]);
    entry.yards[to] += Number(row["yards"]);
    players.set(id, entry);

    // teamPlays repeats on every player's row, so take one reading per
    // play-by-play situation and then add the ones that map together.
    // Taking the max instead undercounted the goal-line snaps by half.
    const seen = perSituation.get(team) ?? new Map<string, number>();
    seen.set(row["situation"] ?? "", Number(row["teamPlays"]));
    perSituation.set(team, seen);
  }

  const situational = new Map<string, SituationalRole[]>();
  const pooled = new Map<string, PlayerRole[]>();

  for (const [id, e] of players) {
    const plays = teamPlays.get(e.team) ?? zero();
    const shareIn = zero(), finishIn = zero(), yardsPerTouch = zero();

    for (const s of SITUATIONS) {
      shareIn[s] = e.touches[s] / Math.max(1, plays[s]);
      finishIn[s] = e.scores[s] / Math.max(1, e.touches[s]);
      yardsPerTouch[s] = e.yards[s] / Math.max(1, e.touches[s]);
    }

    const touches = SITUATIONS.reduce((a, s) => a + e.touches[s], 0);
    const scores = SITUATIONS.reduce((a, s) => a + e.scores[s], 0);
    const yards = SITUATIONS.reduce((a, s) => a + e.yards[s], 0);
    const availability = Math.min(1, (played.get(id) ?? 0) / 17);

    situational.set(e.team, [...(situational.get(e.team) ?? []), {
      playerId: id, position: e.position, shareIn, finishIn, yardsPerTouch,
      catchRate: 0.68, availability,
    }]);

    const allPlays = SITUATIONS.reduce((a, s) => a + plays[s], 0);
    pooled.set(e.team, [...(pooled.get(e.team) ?? []), {
      playerId: id, position: e.position,
      targetShare: e.position === "RB" ? 0.05 : touches / Math.max(1, allPlays),
      carryShare: e.position === "RB" ? touches / Math.max(1, allPlays * 0.45) : 0,
      catchRate: 0.68,
      yardsPerCatch: yards / Math.max(1, touches),
      yardsPerCarry: yards / Math.max(1, touches),
      touchdownShare: scores / Math.max(1, allPlays * 0.05),
      availability,
    }]);
  }

  for (const [team, seen] of perSituation) {
    const counts = zero();

    for (const [situation, plays] of seen) {
      const to = ROLLS_UP_TO[situation as FineSituation];
      if (to) counts[to] += plays;
    }

    teamPlays.set(team, counts);
  }

  const perGame = new Map<string, Record<Situation, number>>();

  for (const [team, counts] of teamPlays) {
    const each = zero();
    for (const s of SITUATIONS) each[s] = counts[s] / 17;
    perGame.set(team, each);
  }

  return { situational, pooled, teamPlays: perGame };
}

async function main(): Promise<void> {
  const { situational, pooled, teamPlays } = await fitRoles(FIT_ON);
  const rng = seededRng(77);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };

  const sims = { pooled: new Map<string, number[]>(), situational: new Map<string, number[]>() };

  for (const [team, roster] of situational) {
    const plays = teamPlays.get(team) ?? LEAGUE_PLAYS;
    const rows = roster.map(() => [] as number[]);

    for (let run = 0; run < RUNS; run++) {
      const lines = simulateSituationalWeek(
        { plays: { ...plays }, passShare: 0.54 }, roster, draws);
      lines.forEach((line, i) => rows[i]!.push(fantasyPoints(line, RULES)));
    }

    roster.forEach((role, i) => sims.situational.set(role.playerId, rows[i]!));
  }

  for (const [team, roster] of pooled) {
    const plays = teamPlays.get(team) ?? LEAGUE_PLAYS;
    const all = SITUATIONS.reduce((a, s) => a + plays[s], 0);
    const rows = roster.map(() => [] as number[]);

    for (let run = 0; run < RUNS; run++) {
      const lines = simulateTeamWeek(
        { passAttempts: all * 0.54, rushAttempts: all * 0.46, impliedTotal: 22 },
        roster, draws);
      lines.forEach((line, i) => rows[i]!.push(fantasyPoints(line, RULES)));
    }

    roster.forEach((role, i) => sims.pooled.set(role.playerId, rows[i]!));
  }

  // what actually happened
  const actual = new Map<string, number[]>();

  for (const row of await loadPlayerStats(SCORE_ON)) {
    if (row.week > 18) continue;
    actual.set(row.playerId, [
      ...(actual.get(row.playerId) ?? []), fantasyPoints(row.statLine, RULES),
    ]);
  }

  // the flat model: last season's average with a pooled spread
  const training = [];
  const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  for (const [id, sim] of sims.situational) {
    const weeks = actual.get(id);
    const position = [...situational.values()].flat().find((r) => r.playerId === id)!.position;
    if (!weeks || weeks.length < 8) continue;
    for (const a of weeks) training.push({ position, predicted: meanOf(sim), actual: a });
  }

  const flat = buildResidualModel(training, 5);

  console.log(`roles fitted on ${FIT_ON}, scored on ${SCORE_ON}\n`);
  console.log("model            80% band covers   band widths, 10th to 90th   median width");

  const score = (label: string, low: (id: string) => number, high: (id: string) => number) => {
    let inside = 0, total = 0;
    const widths: number[] = [];

    for (const [id, weeks] of actual) {
      if (!sims.situational.has(id) || weeks.length < 8) continue;
      const lo = low(id), hi = high(id);
      widths.push(hi - lo);
      for (const a of weeks) {
        total++;
        if (a >= lo && a <= hi) inside++;
      }
    }

    widths.sort((a, b) => a - b);
    console.log(
      label.padEnd(17) + ((inside / total) * 100).toFixed(1).padStart(9) + "%" +
      ("   " + widths[Math.floor(widths.length * 0.1)]!.toFixed(1) + " to " +
        widths[Math.floor(widths.length * 0.9)]!.toFixed(1)).padStart(28) +
      widths[Math.floor(widths.length / 2)]!.toFixed(1).padStart(15),
    );
  };

  const quantileOf = (map: Map<string, number[]>, p: number) => (id: string) => {
    const sorted = [...(map.get(id) ?? [0])].sort((a, b) => a - b);
    return sorted[Math.floor(p * (sorted.length - 1))]!;
  };

  const position = (id: string) =>
    [...situational.values()].flat().find((r) => r.playerId === id)?.position ?? "WR";

  // how much doubt about the role itself makes the bands honest
  console.log("\nadding doubt about what the role turns out to be:\n");
  console.log("role drift   80% band covers   median width   season total, 10th to 90th");

  for (const roleDrift of [0, 0.2, 0.35, 0.5, 0.7, 0.9]) {
    const byGame = new Map<string, { p10: number; p90: number }>();
    const seasons: number[][] = [];

    for (const [team, roster] of situational) {
      const plays = teamPlays.get(team) ?? LEAGUE_PLAYS;
      const out = simulateSeason(
        { plays: { ...plays }, passShare: 0.54 }, roster,
        { ...DEFAULT_SEASON, runs: 400, roleDrift, scoring: RULES }, draws,
      );

      for (const player of out) {
        byGame.set(player.playerId, { p10: player.weekly.p10, p90: player.weekly.p90 });
        if (player.total.median > 40) {
          seasons.push([player.total.p10, player.total.p90]);
        }
      }
    }

    let inside = 0, total = 0;
    const widths: number[] = [];

    for (const [id, weeks] of actual) {
      const band = byGame.get(id);
      if (!band || weeks.length < 8) continue;
      widths.push(band.p90 - band.p10);
      for (const a of weeks) {
        total++;
        if (a >= band.p10 && a <= band.p90) inside++;
      }
    }

    widths.sort((a, b) => a - b);
    const spread = seasons.length > 0
      ? (seasons.reduce((a, s) => a + s[0]!, 0) / seasons.length).toFixed(0) + " to " +
        (seasons.reduce((a, s) => a + s[1]!, 0) / seasons.length).toFixed(0)
      : "none";
    console.log(
      roleDrift.toFixed(2).padEnd(13) + ((inside / total) * 100).toFixed(1).padStart(9) + "%" +
      widths[Math.floor(widths.length / 2)]!.toFixed(1).padStart(15) + spread.padStart(28),
    );
  }

  console.log("");
  score("flat",
    (id) => outcomeQuantile(flat, position(id), meanOf(sims.situational.get(id)!), 0.1),
    (id) => outcomeQuantile(flat, position(id), meanOf(sims.situational.get(id)!), 0.9));
  score("pooled draw", quantileOf(sims.pooled, 0.1), quantileOf(sims.pooled, 0.9));
  score("by situation", quantileOf(sims.situational, 0.1), quantileOf(sims.situational, 0.9));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

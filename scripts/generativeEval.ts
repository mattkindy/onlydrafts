/**
 * Fits each offence's roles from one season and simulates the next,
 * then asks the questions the old additive model could not answer:
 * do a player's simulated weeks land where his actual ones did, and do
 * team-mates move against each other the way they really do?
 *
 * Run: npx tsx scripts/generativeEval.ts --season 2025
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { buildResidualModel, outcomeQuantile } from "../src/backtest/intervals.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import {
  simulateTeamWeek, type Draws, type PlayerRole, type TeamWeek,
} from "../src/model/playerWeek.js";

function argOf(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1]!;
}

const RULES = presets.standard;

interface Fitted {
  team: TeamWeek;
  roles: PlayerRole[];
  names: Map<string, string>;
}

async function fitSeason(season: number): Promise<Map<string, Fitted>> {
  const weeks = await loadPlayerStats(season);
  const byTeam = new Map<string, typeof weeks>();

  for (const w of weeks) {
    byTeam.set(w.teamId, [...(byTeam.get(w.teamId) ?? []), w]);
  }

  const out = new Map<string, Fitted>();

  for (const [teamId, rows] of byTeam) {
    const gameWeeks = new Set(rows.map((r) => r.week));
    const games = Math.max(1, gameWeeks.size);
    const teamTargets = rows.reduce((a, r) => a + r.targets, 0);
    const teamCarries = rows.reduce((a, r) => a + r.carries, 0);
    const teamScores = rows.reduce(
      (a, r) => a + (r.statLine.rushTd ?? 0) + (r.statLine.recTd ?? 0), 0,
    );

    const byPlayer = new Map<string, typeof weeks>();

    for (const r of rows) {
      byPlayer.set(r.playerId, [...(byPlayer.get(r.playerId) ?? []), r]);
    }

    const roles: PlayerRole[] = [];
    const names = new Map<string, string>();

    for (const [playerId, list] of byPlayer) {
      if (!["RB", "WR", "TE"].includes(list[0]!.position)) continue;
      const targets = list.reduce((a, r) => a + r.targets, 0);
      const carries = list.reduce((a, r) => a + r.carries, 0);
      if (targets + carries < 20) continue;
      const receptions = list.reduce((a, r) => a + (r.statLine.receptions ?? 0), 0);
      const recYds = list.reduce((a, r) => a + (r.statLine.recYds ?? 0), 0);
      const rushYds = list.reduce((a, r) => a + (r.statLine.rushYds ?? 0), 0);
      const scores = list.reduce(
        (a, r) => a + (r.statLine.rushTd ?? 0) + (r.statLine.recTd ?? 0), 0,
      );
      names.set(playerId, list[0]!.playerName);
      roles.push({
        playerId,
        position: list[0]!.position,
        targetShare: teamTargets > 0 ? targets / teamTargets : 0,
        carryShare: teamCarries > 0 ? carries / teamCarries : 0,
        catchRate: targets > 0 ? Math.min(0.95, receptions / targets) : 0.6,
        yardsPerCatch: receptions > 0 ? recYds / receptions : 10,
        yardsPerCarry: carries > 0 ? rushYds / carries : 4,
        touchdownShare: teamScores > 0 ? scores / teamScores : 0,
        availability: list.length / games,
      });
    }

    out.set(teamId, {
      team: {
        passAttempts: teamTargets / games,
        rushAttempts: teamCarries / games,
        impliedTotal: (teamScores / games) * 9,
      },
      roles, names,
    });
  }

  return out;
}

function correlation(a: number[], b: number[]): number {
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

async function main(): Promise<void> {
  const season = Number(argOf("--season", "2025"));
  const fitted = await fitSeason(season - 1);
  const rng = seededRng(41);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };
  const RUNS = 3000;

  // simulate every offence, then read each player's own distribution
  const simulated = new Map<string, number[]>();

  for (const { team, roles } of fitted.values()) {
    const rows = roles.map(() => [] as number[]);

    for (let run = 0; run < RUNS; run++) {
      const lines = simulateTeamWeek(team, roles, draws);
      lines.forEach((line, i) => rows[i]!.push(fantasyPoints(line, RULES)));
    }

    roles.forEach((role, i) => simulated.set(role.playerId, rows[i]!));
  }

  // what actually happened the next season
  const actualWeeks = await loadPlayerStats(season);
  const actual = new Map<string, number[]>();
  const teamOf = new Map<string, string>();

  for (const w of actualWeeks) {
    actual.set(w.playerId, [
      ...(actual.get(w.playerId) ?? []), fantasyPoints(w.statLine, RULES),
    ]);
    teamOf.set(w.playerId, w.teamId);
  }

  // the flat model, for comparison: last season's average plus pooled noise
  const prevAvg = new Map<string, { ppg: number; position: string }>();

  for (const { roles } of fitted.values()) {
    for (const role of roles) {
      const sim = simulated.get(role.playerId)!;
      prevAvg.set(role.playerId, {
        ppg: sim.reduce((a, b) => a + b, 0) / sim.length,
        position: role.position,
      });
    }
  }

  const flatTraining = [];

  for (const [playerId, weeks] of actual) {
    const prev = prevAvg.get(playerId);
    if (!prev || weeks.length < 8) continue;
    for (const a of weeks) {
      flatTraining.push({ position: prev.position, predicted: prev.ppg, actual: a });
    }
  }

  const flat = buildResidualModel(flatTraining, 5);

  // where each actual week landed inside each model's curve
  const tails = {
    generative: { inside: 0, outside: 0 },
    flat: { inside: 0, outside: 0 },
  };
  const widths = { generative: [] as number[], flat: [] as number[] };

  for (const [playerId, weeks] of actual) {
    const sim = simulated.get(playerId);
    const prev = prevAvg.get(playerId);
    if (!sim || !prev || weeks.length < 8) continue;
    const sorted = [...sim].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))]!;
    const gLo = q(0.1), gHi = q(0.9);
    const fLo = outcomeQuantile(flat, prev.position, prev.ppg, 0.1);
    const fHi = outcomeQuantile(flat, prev.position, prev.ppg, 0.9);
    widths.generative.push(gHi - gLo);
    widths.flat.push(fHi - fLo);

    for (const a of weeks) {
      if (a >= gLo && a <= gHi) tails.generative.inside++;
      else tails.generative.outside++;
      if (a >= fLo && a <= fHi) tails.flat.inside++;
      else tails.flat.outside++;
    }
  }

  const cover = (t: { inside: number; outside: number }) =>
    (t.inside / (t.inside + t.outside)) * 100;
  const spread = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.1)]!.toFixed(1) + " to " +
      s[Math.floor(s.length * 0.9)]!.toFixed(1);
  };

  console.log(`roles fitted on ${season - 1}, scored on ${season}\n`);
  console.log("model         80% band covers   band widths, 10th to 90th");
  console.log("generative" + (cover(tails.generative).toFixed(1) + "%").padStart(17) +
    "   " + spread(widths.generative));
  console.log("flat      " + (cover(tails.flat).toFixed(1) + "%").padStart(17) +
    "   " + spread(widths.flat));

  // the recorded bug: same-team catchers simulate positive where the data says zero
  const pairsSim: number[] = [], pairsReal: number[] = [];

  for (const { roles } of fitted.values()) {
    const catchers = roles
      .filter((r) => r.position !== "RB" && r.targetShare > 0.12)
      .slice(0, 3);

    for (let i = 0; i < catchers.length; i++) {
      for (let j = i + 1; j < catchers.length; j++) {
        const a = simulated.get(catchers[i]!.playerId)!;
        const b = simulated.get(catchers[j]!.playerId)!;
        pairsSim.push(correlation(a, b));
        const ra = actual.get(catchers[i]!.playerId) ?? [];
        const rb = actual.get(catchers[j]!.playerId) ?? [];
        const n = Math.min(ra.length, rb.length);
        if (n >= 8) pairsReal.push(correlation(ra.slice(0, n), rb.slice(0, n)));
      }
    }
  }

  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  console.log(`\nsame-team catcher pairs (${pairsSim.length} simulated, ${pairsReal.length} with enough real weeks)`);
  console.log("  simulated correlation  " + avg(pairsSim).toFixed(3));
  console.log("  actual correlation     " + avg(pairsReal).toFixed(3));
  console.log("  the additive model recorded +0.07 where the data says about 0");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

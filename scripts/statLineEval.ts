/**
 * Points are a summary. A model that gets them right by handing out
 * yards where the real player got touchdowns is still wrong, and the
 * error shows up the moment a league changes its scoring.
 *
 * So score the line itself: catches, yards through the air, yards on
 * the ground, scores, and the shape of each. The flat model cannot
 * enter, because it only ever produced a number.
 *
 * Run: npx tsx scripts/statLineEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import {
  simulateTeamWeek, type Draws, type PlayerLine, type PlayerRole,
} from "../src/model/playerWeek.js";
import {
  LEAGUE_PLAYS, SITUATIONS, simulateSituationalWeek,
  type Situation, type SituationalRole,
} from "../src/model/situationalWeek.js";
import {
  ROLLS_UP_TO, zeroBySituation as zero, type FineSituation,
} from "../src/model/situations.js";

const FIT_ON = 2024;
const SCORE_ON = 2025;
const WEEKS = 4000;





interface Shape {
  receptions: number;
  recYds: number;
  rushYds: number;
  scores: number;
  hundredYards: number;
  multiScore: number;
  blank: number;
}

function shapeOf(lines: { receptions: number; recYds: number; rushYds: number; scores: number }[]): Shape {
  const mean = (get: (l: (typeof lines)[number]) => number) =>
    lines.reduce((a, l) => a + get(l), 0) / Math.max(1, lines.length);
  const share = (test: (l: (typeof lines)[number]) => boolean) =>
    lines.filter(test).length / Math.max(1, lines.length);

  return {
    receptions: mean((l) => l.receptions),
    recYds: mean((l) => l.recYds),
    rushYds: mean((l) => l.rushYds),
    scores: mean((l) => l.scores),
    hundredYards: share((l) => l.recYds + l.rushYds >= 100),
    multiScore: share((l) => l.scores >= 2),
    blank: share((l) => l.recYds + l.rushYds < 20 && l.scores === 0),
  };
}

const flatten = (line: PlayerLine) => ({
  receptions: line.receptions,
  recYds: line.recYds,
  rushYds: line.rushYds,
  scores: line.recTd + line.rushTd,
});

async function main(): Promise<void> {
  const rows = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "situations.csv"), "utf8"),
  ).filter((r) => Number(r["season"]) === FIT_ON);

  const positions = new Map<string, string>();
  for (const s of await loadPlayerStats(FIT_ON)) positions.set(s.playerId, s.position);

  const players = new Map<string, {
    team: string; position: string;
    touches: Record<Situation, number>; scores: Record<Situation, number>;
    yards: Record<Situation, number>;
  }>();
  const teamPlays = new Map<string, Record<Situation, number>>();
  const perSituation = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const to = ROLLS_UP_TO[(row["situation"] ?? "") as FineSituation];
    const id = row["player"] ?? "";
    const team = row["team"] ?? "";
    if (!to || !["RB", "WR", "TE"].includes(positions.get(id) ?? "")) continue;

    const e = players.get(id) ??
      { team, position: positions.get(id)!, touches: zero(), scores: zero(), yards: zero() };
    e.touches[to] += Number(row["touches"]);
    e.scores[to] += Number(row["scores"]);
    e.yards[to] += Number(row["yards"]);
    players.set(id, e);

    // teamPlays repeats on every player's row, so take one reading per
    // play-by-play situation and then add the ones that map together.
    // Taking the max instead undercounted the goal-line snaps by half.
    const seen = perSituation.get(team) ?? new Map<string, number>();
    seen.set(row["situation"] ?? "", Number(row["teamPlays"]));
    perSituation.set(team, seen);
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

  const bySide = new Map<string, { situational: SituationalRole[]; pooled: PlayerRole[] }>();

  for (const [id, e] of players) {
    const plays = perGame.get(e.team) ?? LEAGUE_PLAYS;
    const shareIn = zero(), finishIn = zero(), yardsPerTouch = zero();

    for (const s of SITUATIONS) {
      shareIn[s] = e.touches[s] / Math.max(1, plays[s] * 17);
      finishIn[s] = e.scores[s] / Math.max(1, e.touches[s]);
      yardsPerTouch[s] = e.yards[s] / Math.max(1, e.touches[s]);
    }

    const touches = SITUATIONS.reduce((a, s) => a + e.touches[s], 0);
    const yards = SITUATIONS.reduce((a, s) => a + e.yards[s], 0);
    const scores = SITUATIONS.reduce((a, s) => a + e.scores[s], 0);
    const allPlays = SITUATIONS.reduce((a, s) => a + plays[s] * 17, 0);
    const catcher = e.position !== "RB";
    const side = bySide.get(e.team) ?? { situational: [], pooled: [] };

    side.situational.push({
      playerId: id, position: e.position, shareIn, finishIn, yardsPerTouch,
      catchRate: catcher ? 0.63 : 0.75, availability: 1,
    });
    side.pooled.push({
      playerId: id, position: e.position,
      targetShare: catcher ? touches / Math.max(1, allPlays * 0.54) : 0.04,
      carryShare: catcher ? 0 : touches / Math.max(1, allPlays * 0.46),
      catchRate: catcher ? 0.63 : 0.75,
      yardsPerCatch: yards / Math.max(1, touches),
      yardsPerCarry: yards / Math.max(1, touches),
      touchdownShare: scores / Math.max(1, allPlays * 0.055),
      availability: 1,
    });
    bySide.set(e.team, side);
  }

  const rng = seededRng(91);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };
  const sims = {
    pooled: new Map<string, ReturnType<typeof flatten>[]>(),
    situational: new Map<string, ReturnType<typeof flatten>[]>(),
  };

  for (const [team, side] of bySide) {
    const plays = perGame.get(team) ?? LEAGUE_PLAYS;
    const all = SITUATIONS.reduce((a, s) => a + plays[s], 0);

    for (let week = 0; week < WEEKS / 40; week++) {
      simulateSituationalWeek({ plays: { ...plays }, passShare: 0.54 }, side.situational, draws)
        .forEach((line, i) => {
          const id = side.situational[i]!.playerId;
          sims.situational.set(id, [...(sims.situational.get(id) ?? []), flatten(line)]);
        });
      simulateTeamWeek(
        { passAttempts: all * 0.54, rushAttempts: all * 0.46, impliedTotal: 22 },
        side.pooled, draws,
      ).forEach((line, i) => {
        const id = side.pooled[i]!.playerId;
        sims.pooled.set(id, [...(sims.pooled.get(id) ?? []), flatten(line)]);
      });
    }
  }

  // what they actually did
  const real = new Map<string, ReturnType<typeof flatten>[]>();

  for (const row of await loadPlayerStats(SCORE_ON)) {
    if (row.week > 18 || !players.has(row.playerId)) continue;
    real.set(row.playerId, [...(real.get(row.playerId) ?? []), {
      receptions: row.statLine.receptions ?? 0,
      recYds: row.statLine.recYds ?? 0,
      rushYds: row.statLine.rushYds ?? 0,
      scores: (row.statLine.recTd ?? 0) + (row.statLine.rushTd ?? 0),
    }]);
  }

  const ids = [...real].filter(([, weeks]) => weeks.length >= 10).map(([id]) => id);
  const gather = (from: Map<string, ReturnType<typeof flatten>[]>) =>
    shapeOf(ids.flatMap((id) => from.get(id) ?? []));

  const actual = gather(real);
  const pooled = gather(sims.pooled);
  const situational = gather(sims.situational);

  console.log(`${ids.length} players, fitted on ${FIT_ON}, scored on ${SCORE_ON}\n`);
  console.log("stat                    actual   pooled draw   by situation   who is closer");

  for (const [label, key, decimals] of [
    ["catches a game", "receptions", 2],
    ["yards through air", "recYds", 1],
    ["yards on ground", "rushYds", 1],
    ["scores a game", "scores", 3],
    ["100 yard games", "hundredYards", 3],
    ["two score games", "multiScore", 4],
    ["games under 20 yards", "blank", 3],
  ] as [string, keyof Shape, number][]) {
    const gapPooled = Math.abs(pooled[key] - actual[key]);
    const gapSituational = Math.abs(situational[key] - actual[key]);
    console.log(
      label.padEnd(22) +
      actual[key].toFixed(decimals).padStart(9) +
      pooled[key].toFixed(decimals).padStart(14) +
      situational[key].toFixed(decimals).padStart(15) +
      (gapSituational < gapPooled ? "   by situation" : "   pooled"),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

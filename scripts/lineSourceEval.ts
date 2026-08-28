/**
 * Whose stat lines come out right: the season regression's, which the
 * board ships, or one model over the parts of a man's play.
 *
 * Both predict a man's per game line for a season from what came
 * before it, and both are marked against what he then did, category by
 * category, plus the ordering of the points his line implies.
 *
 * Run: npx tsx scripts/lineSourceEval.ts [season]
 */

import { buildPreseasonWorld } from "../src/features/preseason.js";
import {
  fitJointLine, LINE_PARTS, type LinePart, type Parts,
} from "../src/features/jointParts.js";
import { partsIn } from "../src/data/advancedParts.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { rmse, spearman } from "../src/backtest/metrics.js";

const SEASON = Number(process.argv[2] ?? 2024);
const RULES = presets.ppr;
const POSITIONS = ["QB", "RB", "WR", "TE"];

async function lineIn(season: number) {
  const out = new Map<string, {
    position: string; games: number; line: Record<LinePart, number>;
  }>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !POSITIONS.includes(s.position)) {
      continue;
    }

    const so = out.get(s.playerId) ?? {
      position: s.position, games: 0,
      line: Object.fromEntries(LINE_PARTS.map((p) => [p, 0])) as
        Record<LinePart, number>,
    };
    so.games++;
    so.line.passYds += s.statLine.passYds;
    so.line.passTd += s.statLine.passTd;
    so.line.interceptions += s.statLine.interceptions;
    so.line.rushYds += s.statLine.rushYds;
    so.line.rushTd += s.statLine.rushTd;
    so.line.receptions += s.statLine.receptions;
    so.line.recYds += s.statLine.recYds;
    so.line.recTd += s.statLine.recTd;
    so.line.passAtt += s.passing.attempts;
    so.line.passCmp += s.passing.completions;
    so.line.carries += s.carries;
    so.line.targets += s.targets;
    out.set(s.playerId, so);
  }

  return out;
}

const perGame = (line: Record<LinePart, number>, games: number) =>
  Object.fromEntries(LINE_PARTS.map((p) => [p, line[p] / Math.max(1, games)])) as
    Record<LinePart, number>;

// teach the line model on pairs that finished before the season marked
const learn: { parts: Parts; position: string; line: Record<LinePart, number> }[] = [];

for (let year = 2018; year < SEASON - 1; year++) {
  const before = await partsIn(year);
  const after = await lineIn(year + 1);

  for (const [who, his] of before) {
    const next = after.get(who);

    if (!next || next.games < 6 || his.games < 4) {
      continue;
    }

    learn.push({
      parts: his, position: next.position, line: perGame(next.line, next.games),
    });
  }
}

const fitted = fitJointLine(learn);
const lastYear = await partsIn(SEASON - 1);
const world = await buildPreseasonWorld(SEASON);
const truth = await lineIn(SEASON);

const pointsOf = (line: Record<LinePart, number>) => fantasyPoints({
  passYds: line.passYds, passTd: line.passTd, interceptions: line.interceptions,
  rushYds: line.rushYds, rushTd: line.rushTd, receptions: line.receptions,
  recYds: line.recYds, recTd: line.recTd, fumblesLost: 0, twoPointConversions: 0,
}, RULES);

console.log(`taught on ${learn.length}; marking ${SEASON} per game lines\n`);
console.log("            n   points err      order       rec yds err   rush yds err  pass yds err");

for (const position of POSITIONS) {
  const rows: { joint: Record<LinePart, number>; ship: Record<string, number> | undefined;
    was: Record<LinePart, number> }[] = [];

  for (const p of world.players) {
    if (p.position !== position) {
      continue;
    }

    const was = truth.get(p.playerId);
    const his = lastYear.get(p.playerId);

    if (!was || was.games < 6 || !his || his.games < 4) {
      continue;
    }

    rows.push({
      joint: fitted.says(his, position),
      ship: p.projectedParts as unknown as Record<string, number> | undefined,
      was: perGame(was.line, was.games),
    });
  }

  const withShip = rows.filter((r) => r.ship);

  if (withShip.length < 20) {
    console.log(`  ${position}: too few (${withShip.length})`);
    continue;
  }

  const wasPts = withShip.map((r) => pointsOf(r.was));
  const err = (of: (r: typeof withShip[number]) => number, was2: number[]) =>
    rmse(withShip.map(of), was2);
  const line = (name: string, of: (r: typeof withShip[number]) =>
    Record<string, number>) =>
    console.log(
      `  ${position} ${name.padEnd(6)} ${String(withShip.length).padStart(3)}  ` +
      `${err((r) => pointsOf(of(r) as Record<LinePart, number>), wasPts).toFixed(2).padStart(9)}  ` +
      `${spearman(withShip.map((r) => pointsOf(of(r) as Record<LinePart, number>)), wasPts).toFixed(3).padStart(9)}  ` +
      `${err((r) => of(r)["recYds"] ?? 0, withShip.map((r2) => r2.was.recYds)).toFixed(1).padStart(11)}  ` +
      `${err((r) => of(r)["rushYds"] ?? 0, withShip.map((r2) => r2.was.rushYds)).toFixed(1).padStart(11)}  ` +
      `${err((r) => of(r)["passYds"] ?? 0, withShip.map((r2) => r2.was.passYds)).toFixed(1).padStart(11)}`,
    );
  line("joint", (r) => r.joint);
  line("ships", (r) => r.ship!);
}

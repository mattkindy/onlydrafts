/**
 * Which week to week signals carry anything, tested on their own.
 *
 * Everything so far has gone through the simulator, which can hide a
 * signal by not using it well. These skip it: for each thing a manager
 * looks at on a Sunday, does it line up with how far a man landed from
 * his own average that week.
 *
 * Anything worked out from the season leaves out the week it is being
 * used on, so nothing sees its own answer.
 *
 * Run: npx tsx scripts/weeklySignalEval.ts
 */

import { spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { sizeOf } from "../src/features/gameSize.js";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;
const SCORE_ON = 2025;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface Row {
  playerId: string;
  position: string;
  team: string;
  week: number;
  points: number;
  touches: number;
  opponent: string;
  home: boolean;
  /** points this game was expected to reach, and this team's cut of it */
  total?: number;
  ownTotal?: number;
  favouredBy?: number;
}

async function main(): Promise<void> {
  const games = await loadGames();
  const meeting = new Map<string, {
    opponent: string; home: boolean;
    total?: number; favouredBy?: number;
  }>();

  for (const game of games) {
    if (game.season !== SCORE_ON || game.week > 18) continue;
    const total = game.totalLine;
    const line = game.spreadLine;
    meeting.set(`${game.week}|${game.homeTeamId}`, {
      opponent: game.awayTeamId, home: true, total,
      favouredBy: line,
    });
    meeting.set(`${game.week}|${game.awayTeamId}`, {
      opponent: game.homeTeamId, home: false, total,
      favouredBy: line === undefined ? undefined : -line,
    });
  }

  const rows: Row[] = [];

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    const met = meeting.get(`${s.week}|${s.teamId}`);
    if (!met) continue;
    rows.push({
      playerId: s.playerId, position: s.position, team: s.teamId, week: s.week,
      points: fantasyPoints(s.statLine, RULES),
      touches: s.carries + s.targets,
      opponent: met.opponent, home: met.home,
      total: met.total, favouredBy: met.favouredBy,
      ownTotal: met.total === undefined || met.favouredBy === undefined
        ? undefined
        : met.total / 2 + met.favouredBy / 2,
    });
  }

  const byPlayer = new Map<string, Row[]>();

  for (const row of rows) {
    byPlayer.set(row.playerId, [...(byPlayer.get(row.playerId) ?? []), row]);
  }

  const players = [...byPlayer.values()]
    .filter((w) => w.length >= 8 && middle(w.map((x) => x.touches)) >= 3)
    .map((w) => [...w].sort((a, b) => a.week - b.week));
  const kept = new Set(players.map((w) => w[0]!.playerId));
  console.log(`${players.length} men, ${rows.length} player-weeks read\n`);

  /**
   * What a defence gave up to this position, per game, worked out
   * without the game being asked about.
   */
  const allowed = (defence: string, position: string, exceptWeek: number) => {
    const against = rows.filter((r) =>
      r.opponent === defence && r.position === position &&
      r.week !== exceptWeek && kept.has(r.playerId));

    if (against.length < 10) {
      return NaN;
    }

    const weeks = new Set(against.map((r) => r.week));
    return against.reduce((a, r) => a + r.points, 0) / weeks.size;
  };

  const signals: [string, (row: Row) => number][] = [
    ["what that defence gives his position", (row) =>
      allowed(row.opponent, row.position, row.week)],
    ["what the game is expected to total", (row) => row.total ?? NaN],
    ["what his team is expected to score", (row) => row.ownTotal ?? NaN],
    ["by how much his team is favoured", (row) => row.favouredBy ?? NaN],
    ["playing at home", (row) => (row.home ? 1 : 0)],
  ];

  console.log("against how far he landed from his own average that week");
  console.log("  signal                                    spearman");

  for (const [label, of] of signals) {
    const said: number[] = [];
    const was: number[] = [];

    for (const own of players) {
      const usable = own.filter((row) => Number.isFinite(of(row)));

      if (usable.length < 5) {
        continue;
      }

      const saidMid = middle(usable.map(of));
      const wasMid = middle(usable.map((r) => r.points));

      for (const row of usable) {
        said.push(of(row) - saidMid);
        was.push(row.points - wasMid);
      }
    }

    console.log(
      "  " + label.padEnd(40) + spearman(said, was).toFixed(4).padStart(8) +
      ` give or take ${noise(said.length).toFixed(3)} (${said.length})`,
    );
  }

  /**
   * All of them at once, fitted on the first half of the season and
   * scored on the second, so the combination is not judged on the weeks
   * that chose it.
   */
  const asRow = (row: Row, mids: number[]) =>
    [1, ...signals.map(([, of], i) => {
      const value = of(row);
      return Number.isFinite(value) ? value - mids[i]! : 0;
    })];

  const learn: { row: number[]; was: number }[] = [];
  const score: { row: number[]; was: number }[] = [];

  for (const own of players) {
    const usable = own.filter((row) => signals.every(([, of]) =>
      Number.isFinite(of(row))));

    if (usable.length < 8) {
      continue;
    }

    const mids = signals.map(([, of]) => middle(usable.map(of)));
    const wasMid = middle(usable.map((r) => r.points));

    for (const row of usable) {
      (row.week <= 9 ? learn : score).push({
        row: asRow(row, mids), was: row.points - wasMid,
      });
    }
  }

  const weights = fitRidge(
    learn.map((e) => e.row), learn.map((e) => e.was), 5,
  );
  const guess = score.map((e) => predictRidge(weights, e.row));
  const truth = score.map((e) => e.was);

  console.log(
    `\nall of them together, fitted on weeks 1 to 9 and scored on 10 to 18` +
    `\n  ${spearman(guess, truth).toFixed(4)} give or take ${noise(truth.length).toFixed(3)}` +
    ` on ${truth.length} weeks`,
  );

  // and how the best one on its own does over those same later weeks
  const bestAlone = score.map((e) => e.row[3]!);
  console.log(
    `  what his team is expected to score alone: ` +
      `${spearman(bestAlone, truth).toFixed(4)}`,
  );

  /**
   * A man's ordinary week moved by how big this one looks.
   *
   * His own average is used in place of what the walk would say about
   * an ordinary week, since within one player the walk gives him nearly
   * the same number every time. Scaling it is what the market buys.
   */
  {
    const said: number[] = [];
    const was: number[] = [];
    const flat: number[] = [];

    for (const own of players) {
      const usable = own.filter((row) =>
        row.total !== undefined && row.favouredBy !== undefined);

      if (usable.length < 5) {
        continue;
      }

      const ordinary = middle(usable.map((r) => r.points));
      const wasMid = middle(usable.map((r) => r.points));
      const scaled = usable.map((row) =>
        ordinary * sizeOf({ total: row.total!, favouredBy: row.favouredBy! }));
      const saidMid = middle(scaled);

      for (let i = 0; i < usable.length; i++) {
        said.push(scaled[i]! - saidMid);
        flat.push(0);
        was.push(usable[i]!.points - wasMid);
      }
    }

    console.log(
      "\nhis ordinary week, moved by how big this one looks" +
      `\n  ${spearman(said, was).toFixed(4)} give or take ` +
      `${noise(said.length).toFixed(3)} on ${said.length} weeks` +
      "\n  (his ordinary week unmoved would be 0.000, and the whole" +
      "\n   simulation with drives and defences came to 0.049)",
    );
  }

  // and the same signals against his workload, since that is the half
  // of the points anything is likely to move
  console.log("\nand against how much work he got that week");

  for (const [label, of] of signals) {
    const said: number[] = [];
    const was: number[] = [];

    for (const own of players) {
      const usable = own.filter((row) => Number.isFinite(of(row)));
      if (usable.length < 5) continue;
      const saidMid = middle(usable.map(of));
      const wasMid = middle(usable.map((r) => r.touches));

      for (const row of usable) {
        said.push(of(row) - saidMid);
        was.push(row.touches - wasMid);
      }
    }

    console.log(
      "  " + label.padEnd(40) + spearman(said, was).toFixed(4).padStart(8) +
      ` give or take ${noise(said.length).toFixed(3)} (${said.length})`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

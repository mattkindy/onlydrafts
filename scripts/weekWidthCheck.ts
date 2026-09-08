/**
 * Where the walk loses a man's week to week swing.
 *
 * weeklyCeilingEval says the walk moves a man 2.05 points from his own
 * average where he really moves 4.95. That number is read off
 * walkWeek, which plays a fixture forty times and reports the mean.
 * The kept file from playPlayers keeps each of those forty games
 * whole, so the same swing can be measured before the averaging as
 * well as after it, and the two say which side of the divide the
 * missing width is on.
 *
 * Run: npx tsx scripts/weekWidthCheck.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { buildWorld } from "../src/features/playedWorld.js";
import { playGame, linesFrom, type Side } from "../src/model/gameFromDrives.js";
import { seededRng } from "../src/sim/rng.js";

const RULES = presets.standard;
const SEASON = Number(process.argv[2] ?? 2025);
/** how many times each fixture is played when the sides are asked directly */
const RUNS = Number(process.env["RUNS"] ?? 2);

const middle = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

const spreadOf = (v: number[]) => {
  const m = middle(v);

  return Math.sqrt(middle(v.map((x) => (x - m) ** 2)));
};

interface Week {
  week: number;
  points: number;
  touches: number;
  yards: number;
  scores: number;
}

/**
 * Every game the walk deals a man, kept whole. The kept file only has
 * his points, so the touches and the touchdowns are played here.
 */
async function dealGames(
  season: number, positions: Map<string, string>,
): Promise<Map<string, { touches: number; yards: number; scores: number }[]>> {
  const world = await buildWorld(season, 1, false, positions);
  const dealt = new Map<string, { touches: number; yards: number; scores: number }[]>();

  for (const g of await loadGames()) {
    if (g.season !== season || g.week > 18) {
      continue;
    }

    const home = world.sideFor(g.homeTeamId) as Side | undefined;
    const away = world.sideFor(g.awayTeamId) as Side | undefined;

    if (!home || !away) {
      continue;
    }

    for (let run = 0; run < RUNS; run++) {
      const rng = seededRng(
        season * 1000 + g.week * 37 +
        g.homeTeamId.charCodeAt(0) * 131 + g.awayTeamId.charCodeAt(1) +
        run * 7919,
      );
      const game = playGame(home, away, {
        rules: { ...world.rules, kickSucceeds: world.kicking.kickSucceeds },
        fourth: world.fourth,
        clock: {
          isLast: world.kicking.isLast, lastLength: world.kicking.lastLength,
        },
        ticking: world.ticking, season, week: g.week,
      }, rng);

      for (const [id, line] of linesFrom(game, [home, away])) {
        dealt.set(id, [...(dealt.get(id) ?? []), {
          touches: (line.carries ?? 0) + (line.targets ?? 0),
          yards: line.rushYds + line.recYds,
          scores: line.rushTd + line.recTd,
        }]);
      }
    }
  }

  return dealt;
}

async function main(): Promise<void> {
  const kept = JSON.parse(await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${SEASON}.json`), "utf8",
  )) as { runs: number; weeks: number; samples: [string, number[]][] };
  const dealt = new Map(kept.samples);

  const byPlayer = new Map<string, Week[]>();
  const position = new Map<string, string>();

  for (const s of await loadPlayerStats(SEASON)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) {
      continue;
    }

    position.set(s.playerId, s.position);
    byPlayer.set(s.playerId, [...(byPlayer.get(s.playerId) ?? []), {
      week: s.week,
      points: fantasyPoints(s.statLine, RULES),
      touches: s.carries + s.targets,
      yards: s.statLine.rushYds + s.statLine.recYds,
      scores: s.statLine.rushTd + s.statLine.recTd,
    }]);
  }

  const players = [...byPlayer.entries()]
    .filter(([, w]) => w.length >= 8 && middle(w.map((x) => x.touches)) >= 3);

  const played: number[] = [];
  const oneGame: number[] = [];
  const byPos = new Map<string, { played: number[]; oneGame: number[] }>();
  let absent = 0;

  for (const [id, weeks] of players) {
    const pos = position.get(id) ?? "?";
    const bucket = byPos.get(pos) ?? { played: [], oneGame: [] };
    byPos.set(pos, bucket);
    const mean = middle(weeks.map((w) => w.points));

    for (const w of weeks) {
      played.push(w.points - mean);
      bucket.played.push(w.points - mean);
    }

    const his = dealt.get(id);

    if (!his || his.length < 20) {
      absent++;
      continue;
    }

    const dealtMean = middle(his);

    for (const p of his) {
      oneGame.push(p - dealtMean);
      bucket.oneGame.push(p - dealtMean);
    }
  }

  console.log(
    `${players.length} men in ${SEASON}, ${absent} of them not in the kept file, ` +
    `${kept.runs} runs a week\n`,
  );
  const wide = spreadOf(oneGame);
  console.log(`  he really moves          ${spreadOf(played).toFixed(2)}`);
  console.log(`  one game the walk dealt  ${wide.toFixed(2)}`);
  console.log(
    `  the mean of ${kept.runs} of them   ` +
    `${(wide / Math.sqrt(kept.runs)).toFixed(2)} at most, were the ${kept.runs} unrelated`,
  );

  console.log("\n                     really   one dealt game");

  for (const [pos, b] of [...byPos].sort()) {
    if (!b.oneGame.length) {
      continue;
    }

    console.log(
      `  ${pos.padEnd(18)}${spreadOf(b.played).toFixed(2).padStart(7)}` +
      `${spreadOf(b.oneGame).toFixed(2).padStart(17)}`,
    );
  }

  await theThreeParts(players, position);
}

/**
 * The three places a man's week to week swing can come from: how many
 * touches he gets, what each one is worth, and whether he scores.
 * Each is measured on one dealt game, so nothing is averaged first.
 */
async function theThreeParts(
  players: [string, Week[]][], position: Map<string, string>,
): Promise<void> {
  const dealt = await dealGames(SEASON, position);
  const rows = new Map<string, {
    touchReal: number[]; touchWalk: number[];
    perTouchReal: number[]; perTouchWalk: number[];
    scoredReal: number[]; scoredWalk: number[];
  }>();

  for (const [id, weeks] of players) {
    const his = dealt.get(id);

    if (!his || his.length < RUNS * 8) {
      continue;
    }

    const pos = position.get(id) ?? "?";
    const row = rows.get(pos) ?? {
      touchReal: [], touchWalk: [],
      perTouchReal: [], perTouchWalk: [],
      scoredReal: [], scoredWalk: [],
    };
    rows.set(pos, row);

    const realTouch = middle(weeks.map((w) => w.touches));
    const walkTouch = middle(his.map((g) => g.touches));

    for (const w of weeks) {
      row.touchReal.push(w.touches - realTouch);
      row.perTouchReal.push(w.yards / Math.max(1, w.touches));
      row.scoredReal.push(w.scores > 0 ? 1 : 0);
    }

    for (const g of his) {
      row.touchWalk.push(g.touches - walkTouch);
      row.perTouchWalk.push(g.yards / Math.max(1, g.touches));
      row.scoredWalk.push(g.scores > 0 ? 1 : 0);
    }
  }

  console.log(
    `\ntouches a game, off his own mean      really   the walk` +
    `\nyards a touch, spread across games` +
    `\nshare of games with a touchdown`,
  );

  for (const [pos, r] of [...rows].sort()) {
    console.log(`\n  ${pos}`);
    console.log(
      `    touches           ${spreadOf(r.touchReal).toFixed(2).padStart(8)}` +
      `${spreadOf(r.touchWalk).toFixed(2).padStart(11)}`,
    );
    console.log(
      `    yards a touch     ${spreadOf(r.perTouchReal).toFixed(2).padStart(8)}` +
      `${spreadOf(r.perTouchWalk).toFixed(2).padStart(11)}` +
      `   (means ${middle(r.perTouchReal).toFixed(2)} and ` +
      `${middle(r.perTouchWalk).toFixed(2)})`,
    );
    console.log(
      `    scored           ${(100 * middle(r.scoredReal)).toFixed(1).padStart(8)}%` +
      `${(100 * middle(r.scoredWalk)).toFixed(1).padStart(10)}%`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

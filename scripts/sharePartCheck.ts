/**
 * Splits a man's game to game touch swing into the two things that can
 * move it: how many touches his side had, and what cut of them he took.
 *
 * weekWidthCheck says a back moves 3.33 touches in the walk where he
 * really moves 5.09. The walk hands a man the same cut on every snap of
 * every game, so his cut only wanders as far as the coin flips let it.
 * A man taking share s of P touches lands within sqrt(s(1-s)/P) of it by
 * luck alone, so that much is subtracted before the leftover is called
 * movement in the cut itself.
 *
 * Run: npx tsx scripts/sharePartCheck.ts [season]
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { buildWorld } from "../src/features/playedWorld.js";
import { playGame, linesFrom, type Side } from "../src/model/gameFromDrives.js";
import { seededRng } from "../src/sim/rng.js";

const SEASON = Number(process.argv[2] ?? 2025);
const RUNS = Number(process.env["RUNS"] ?? 2);
const POSITIONS = ["RB", "WR", "TE"];

const middle = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

const varianceOf = (v: number[]) => {
  const m = middle(v);

  return middle(v.map((x) => (x - m) ** 2));
};

const spreadOf = (v: number[]) => Math.sqrt(varianceOf(v));

/** one appearance: what he got, and what his side had to give */
interface Game {
  touches: number;
  sideTouches: number;
}

/** every appearance the real season gave a man, with his side's total beside it */
async function realGames(
  season: number,
): Promise<{ games: Map<string, Game[]>; position: Map<string, string> }> {
  const rows = (await loadPlayerStats(season)).filter(
    (s) => s.week <= 18 && POSITIONS.includes(s.position),
  );
  const sideTotal = new Map<string, number>();
  const position = new Map<string, string>();

  for (const s of rows) {
    const key = `${s.teamId}|${s.week}`;
    sideTotal.set(key, (sideTotal.get(key) ?? 0) + s.carries + s.targets);
    position.set(s.playerId, s.position);
  }

  const games = new Map<string, Game[]>();

  for (const s of rows) {
    const side = sideTotal.get(`${s.teamId}|${s.week}`) ?? 0;

    if (side <= 0) {
      continue;
    }

    games.set(s.playerId, [...(games.get(s.playerId) ?? []), {
      touches: s.carries + s.targets, sideTouches: side,
    }]);
  }

  return { games, position };
}

/** the same, off games the walk dealt, kept whole */
async function walkGames(
  season: number, position: Map<string, string>,
): Promise<Map<string, Game[]>> {
  const world = await buildWorld(season, 1, false, position);
  const dealt = new Map<string, Game[]>();

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
      const lines = linesFrom(game, [home, away]);

      for (const side of [home, away]) {
        const his = new Map<string, number>();
        let total = 0;

        for (const man of side.among) {
          const line = lines.get(man);

          if (!line || !POSITIONS.includes(position.get(man) ?? "")) {
            continue;
          }

          const touches = (line.carries ?? 0) + (line.targets ?? 0);
          his.set(man, touches);
          total += touches;
        }

        if (total <= 0) {
          continue;
        }

        for (const [man, touches] of his) {
          dealt.set(man, [...(dealt.get(man) ?? []), {
            touches, sideTouches: total,
          }]);
        }
      }
    }
  }

  return dealt;
}

interface Parts {
  /** how far his touches move, game to game */
  touchSpread: number;
  /** the part his side's play count explains, holding his cut still */
  fromCount: number;
  /** the part his cut explains, holding the play count still */
  fromShare: number;
  /** how much of that cut movement is the coin flips within one game */
  fromFlips: number;
  /** and how much is left once they are taken out, as a fraction of his cut */
  swing: number;
}

/**
 * One man's swing, split. Each part is written as touches so it can be
 * read against the whole, and the cut part is written again as a
 * fraction of his own cut so it can be pooled across men.
 */
function partsFor(games: Game[]): Parts | undefined {
  if (games.length < 6) {
    return undefined;
  }

  const shares = games.map((g) => g.touches / g.sideTouches);
  const counts = games.map((g) => g.sideTouches);
  const meanShare = middle(shares);
  const meanCount = middle(counts);

  if (meanShare <= 0) {
    return undefined;
  }

  const flipVariance = middle(
    games.map((g) => (meanShare * (1 - meanShare)) / g.sideTouches),
  );
  const shareVariance = varianceOf(shares);
  const left = Math.max(0, shareVariance - flipVariance);

  return {
    touchSpread: spreadOf(games.map((g) => g.touches)),
    fromCount: meanShare * spreadOf(counts),
    fromShare: meanCount * Math.sqrt(shareVariance),
    fromFlips: meanCount * Math.sqrt(flipVariance),
    swing: Math.sqrt(left) / meanShare,
  };
}

function report(label: string, byPos: Map<string, Parts[]>): void {
  console.log(`\n${label}`);
  console.log(
    "                 men   touches   his side ran   his cut   " +
    "of that, flips   left over",
  );

  for (const [pos, rows] of [...byPos].sort()) {
    console.log(
      `  ${pos.padEnd(6)}${String(rows.length).padStart(10)}` +
      `${middle(rows.map((r) => r.touchSpread)).toFixed(2).padStart(10)}` +
      `${middle(rows.map((r) => r.fromCount)).toFixed(2).padStart(15)}` +
      `${middle(rows.map((r) => r.fromShare)).toFixed(2).padStart(10)}` +
      `${middle(rows.map((r) => r.fromFlips)).toFixed(2).padStart(17)}` +
      `${middle(rows.map((r) => r.swing)).toFixed(3).padStart(12)}`,
    );
  }
}

function group(
  games: Map<string, Game[]>, position: Map<string, string>, keep: Set<string>,
): Map<string, Parts[]> {
  const byPos = new Map<string, Parts[]>();

  for (const [id, his] of games) {
    if (!keep.has(id)) {
      continue;
    }

    const parts = partsFor(his);

    if (!parts) {
      continue;
    }

    const pos = position.get(id) ?? "?";
    byPos.set(pos, [...(byPos.get(pos) ?? []), parts]);
  }

  return byPos;
}

async function main(): Promise<void> {
  const { games, position } = await realGames(SEASON);
  const keep = new Set(
    [...games].filter(([, his]) =>
      his.length >= 8 && middle(his.map((g) => g.touches)) >= 3,
    ).map(([id]) => id),
  );

  console.log(`${SEASON}: ${keep.size} men, ${RUNS} walks a fixture`);
  console.log(
    "\nEvery column is touches a game, except the last, which is his cut" +
    "\nmoving as a fraction of itself once the flips are taken out.",
  );
  report("really", group(games, position, keep));
  report("the walk", group(await walkGames(SEASON, position), position, keep));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

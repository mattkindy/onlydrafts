/**
 * Which of the walk's draws are missing a game-level swing.
 *
 * sharePartCheck found one: a man's cut of the work was drawn on every
 * snap, so across a game it averaged out and his touches barely moved.
 * Every other quantity the walk draws is the same candidate. For each,
 * the real game-to-game spread is split into the coin flips inside one
 * game and the swing of the game itself, the walk is split the same
 * way, and the two game-level numbers go side by side. The real side
 * comes off the curated plays; the walk side plays a season once.
 *
 * Run: npx tsx scripts/gameSwingCheck.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { buildWorld } from "../src/features/playedWorld.js";
import {
  meanSplit, middle, poolSplits, rateSplit, type Split, type Tally,
} from "../src/features/gameSwing.js";
import { playGame, type Side } from "../src/model/gameFromDrives.js";
import { seededRng } from "../src/sim/rng.js";

const SEASON = Number(process.argv[2] ?? 2025);
const RUNS = Number(process.env["RUNS"] ?? 2);
const POSITIONS = ["RB", "WR", "TE"];
const CURATED = join(import.meta.dirname, "..", "data", "curated");

/** one side's afternoon: what it ran, what it made of it */
interface SideGame {
  plays: number;
  runs: number;
  gains: number[];
  turnovers: number;
  /** and how many times it had the ball, which sets what the plays sit on */
  drives: number;
}

/** one man's afternoon */
interface ManGame {
  gains: number[];
  scores: number;
}

/** one passer's afternoon */
interface PasserGame {
  attempts: number;
  completions: number;
}

interface Season {
  sides: Map<string, SideGame[]>;
  men: Map<string, ManGame[]>;
  passers: Map<string, PasserGame[]>;
}

const blankSide = (): SideGame =>
  ({ plays: 0, runs: 0, gains: [], turnovers: 0, drives: 0 });

function push<K, V>(into: Map<K, V[]>, key: K, value: V): void {
  const already = into.get(key);

  if (already) {
    already.push(value);
    return;
  }

  into.set(key, [value]);
}

const before = (key: string) => key.split("|")[0] ?? "";

/**
 * Every side's game, every man's game and every passer's game, off the
 * curated plays. Sides come from the play file because it says whether
 * a snap was a run; men and passers come from the touch file because
 * only that one says who had the ball.
 */
async function reality(season: number): Promise<Season> {
  const plays = parseCsv(await readFile(join(CURATED, "plays.csv"), "utf8"));
  const byGame = new Map<string, SideGame>();
  const hadBall = new Map<string, Set<string>>();

  for (const r of plays) {
    const call = r["playType"] ?? "";

    if (Number(r["season"]) !== season || Number(r["week"]) > 18 ||
        (call !== "run" && call !== "pass")) {
      continue;
    }

    const key = `${r["offense"]}|${r["week"]}`;
    const game = byGame.get(key) ?? blankSide();
    byGame.set(key, game);
    game.plays++;
    game.runs += call === "run" ? 1 : 0;
    game.gains.push(Number(r["yards"]) || 0);
    game.turnovers += Number(r["turnover"]) || 0;

    const its = hadBall.get(key) ?? new Set<string>();
    hadBall.set(key, its);
    its.add(r["drive"] ?? "");
    game.drives = its.size;
  }

  const touches = parseCsv(await readFile(join(CURATED, "touches.csv"), "utf8"));
  const manGames = new Map<string, ManGame>();
  const passerGames = new Map<string, PasserGame>();

  for (const r of touches) {
    if (Number(r["season"]) !== season || Number(r["week"]) > 18) {
      continue;
    }

    const week = r["week"];
    const man = r["player"] ?? "";

    if (man) {
      const key = `${man}|${week}`;
      const game = manGames.get(key) ?? { gains: [], scores: 0 };
      manGames.set(key, game);
      game.gains.push(r["caught"] === "0" ? 0 : Number(r["yards"]) || 0);
      game.scores += Number(r["touchdown"]) || 0;
    }

    const passer = r["passer"] ?? "";
    const caught = r["caught"] ?? "";

    if (r["playType"] === "pass" && passer && (caught === "0" || caught === "1")) {
      const key = `${passer}|${week}`;
      const game = passerGames.get(key) ?? { attempts: 0, completions: 0 };
      passerGames.set(key, game);
      game.attempts++;
      game.completions += caught === "1" ? 1 : 0;
    }
  }

  const sides = new Map<string, SideGame[]>();
  const men = new Map<string, ManGame[]>();
  const passers = new Map<string, PasserGame[]>();

  for (const [key, game] of byGame) {
    push(sides, before(key), game);
  }

  for (const [key, game] of manGames) {
    push(men, before(key), game);
  }

  for (const [key, game] of passerGames) {
    push(passers, before(key), game);
  }

  return { sides, men, passers };
}

/**
 * The same season dealt. Each run of a fixture is kept as its own side
 * and its own man, so a side gets the seventeen games a real one gets
 * and the two are read on the same footing.
 */
async function dealt(season: number, position: Map<string, string>): Promise<Season> {
  const world = await buildWorld(season, 1, false, position);
  const sides = new Map<string, SideGame[]>();
  const men = new Map<string, ManGame[]>();
  const passers = new Map<string, PasserGame[]>();

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

      const bySide = new Map<string, SideGame>();
      const byMan = new Map<string, ManGame>();
      const byPasser = new Map<string, PasserGame>();

      for (const one of game.possessions) {
        const side = bySide.get(one.team) ?? blankSide();
        bySide.set(one.team, side);
        const passer = one.team === home.team ? home.passer : away.passer;

        if (one.drive.ending === "turnover") {
          side.turnovers++;
        }

        if (one.drive.plays.some((play) => play.player)) {
          side.drives++;
        }

        for (const play of one.drive.plays) {
          // a snap nobody was named on is a flag, which the curated
          // plays keep apart from the run and the throw as well
          if (!play.player) {
            continue;
          }

          side.plays++;
          side.runs += play.call === "run" ? 1 : 0;
          side.gains.push(play.yards);

          const his = byMan.get(play.player) ?? { gains: [], scores: 0 };
          byMan.set(play.player, his);
          // a throw he did not catch was a sack or a ball away, whose
          // yards the stat line charges to nobody
          his.gains.push(play.caught ? play.yards : 0);
          his.scores += play.scored ? 1 : 0;

          if (play.call === "pass" && passer) {
            const day = byPasser.get(passer) ?? { attempts: 0, completions: 0 };
            byPasser.set(passer, day);
            day.attempts++;
            day.completions += play.caught ? 1 : 0;
          }
        }
      }

      for (const [team, side] of bySide) {
        push(sides, `${team}|${run}`, side);
      }

      for (const [man, his] of byMan) {
        push(men, `${man}|${run}`, his);
      }

      for (const [who, day] of byPasser) {
        push(passers, `${who}|${run}`, day);
      }
    }
  }

  return { sides, men, passers };
}

/** every unit's split for one quantity, pooled into a single row */
function pool<T>(
  units: Map<string, T[]>, of: (games: T[]) => Split | undefined,
  keep?: Set<string>,
): Split | undefined {
  const splits: Split[] = [];

  for (const [key, games] of units) {
    if (keep && !keep.has(before(key))) {
      continue;
    }

    const split = of(games);

    if (split) {
      splits.push(split);
    }
  }

  return splits.length ? poolSplits(splits) : undefined;
}

interface Row {
  what: string;
  unit: string;
  real?: Split;
  walk?: Split;
  /** what the gap is worth in fantasy points a week, where it can be said */
  worth?: number;
}

const shown = (split: Split | undefined, key: keyof Split) =>
  split ? split[key].toFixed(3).padStart(9) : "        .";

const gapOf = (row: Row) =>
  row.real && row.walk ? row.real.gameLevel - row.walk.gameLevel : 0;

function report(rows: Row[]): void {
  console.log(
    "\n  quantity                       unit          real   " +
    "the walk        gap   points",
  );

  for (const row of [...rows].sort((a, b) => Math.abs(gapOf(b)) - Math.abs(gapOf(a)))) {
    const gap = row.real && row.walk
      ? gapOf(row).toFixed(3).padStart(11)
      : "          .";
    console.log(
      `  ${row.what.padEnd(29)}${row.unit.padEnd(11)}` +
      `${shown(row.real, "gameLevel")}${shown(row.walk, "gameLevel")}${gap}` +
      `${(row.worth === undefined ? "" : row.worth.toFixed(2)).padStart(9)}`,
    );
  }
}

const playCounts = (games: SideGame[]) => games.map((g) => g.plays);
const runShare = (games: SideGame[]): Tally[] =>
  games.map((g) => ({ tries: g.plays, hits: g.runs }));
const givenAway = (games: SideGame[]): Tally[] =>
  games.map((g) => ({ tries: g.plays, hits: g.turnovers }));
const sideYards = (games: SideGame[]) => games.map((g) => g.gains);
const manYards = (games: ManGame[]) => games.map((g) => g.gains);
const manScores = (games: ManGame[]): Tally[] =>
  games.map((g) => ({ tries: g.gains.length, hits: g.scores }));
/**
 * A passer's day, counting only the days he actually threw. A backup
 * with four throws is mostly coin flips, and pooling him beside a
 * starter said the completion rate swings twice as far as it does.
 */
const completions = (games: PasserGame[]): Tally[] =>
  games.filter((g) => g.attempts >= 15)
    .map((g) => ({ tries: g.attempts, hits: g.completions }));

/**
 * A side's play count has no draws inside it to average out, so there
 * is nothing to subtract: the whole spread is the game.
 */
const countSplit = (counts: number[]): Split | undefined => {
  if (counts.length < 4) {
    return undefined;
  }

  const mid = middle(counts);
  const spread = Math.sqrt(middle(counts.map((c) => (c - mid) ** 2)));

  return { total: spread, flips: 0, gameLevel: spread };
};

async function main(): Promise<void> {
  const position = new Map<string, string>();
  const touchesOf = new Map<string, number[]>();

  for (const s of await loadPlayerStats(SEASON)) {
    if (s.week > 18) {
      continue;
    }

    position.set(s.playerId, s.position);

    if (POSITIONS.includes(s.position)) {
      push(touchesOf, s.playerId, s.carries + s.targets);
    }
  }

  const keep = new Set(
    [...touchesOf].filter(([, weeks]) => weeks.length >= 8 && middle(weeks) >= 3)
      .map(([id]) => id),
  );
  const real = await reality(SEASON);
  const walk = await dealt(SEASON, position);

  console.log(
    `${SEASON}: ${real.sides.size} sides, ${keep.size} men, ` +
    `${RUNS} walks a fixture\n`,
  );

  const rows: Row[] = [];
  const add = (
    what: string, unit: string,
    of: { real?: Split; walk?: Split }, worth?: number,
  ) => {
    rows.push({ what, unit, real: of.real, walk: of.walk, worth });
  };

  /**
   * What a swing is worth to a man's week. A back takes a share of his
   * side's snaps and makes a few yards of each, so a play the side
   * does not run costs him that share of a touch, and a yard he does
   * not make on a touch costs a tenth of a point.
   */
  const backs = [...keep].filter((id) => position.get(id) === "RB");
  const backTouches = middle(backs.map((id) => middle(touchesOf.get(id) ?? [0])));
  const sideGames = [...real.sides.values()].flat();
  const sidePlays = middle(sideGames.map((g) => g.plays));
  const backShare = backTouches / Math.max(1, sidePlays);
  const yardsAPlay = middle(sideGames.flatMap((g) => g.gains));

  const count = {
    real: countSplit([...real.sides.values()].flatMap(playCounts)),
    walk: countSplit([...walk.sides.values()].flatMap(playCounts)),
  };
  add(
    "the side's play count", "plays", count,
    count.real && count.walk
      ? 0.1 * yardsAPlay * backShare * (count.real.gameLevel - count.walk.gameLevel)
      : undefined,
  );
  add("the side's drives", "drives", {
    real: countSplit([...real.sides.values()].flatMap(
      (games) => games.map((g) => g.drives))),
    walk: countSplit([...walk.sides.values()].flatMap(
      (games) => games.map((g) => g.drives))),
  });
  add("the side's plays a drive", "plays", {
    real: countSplit([...real.sides.values()].flatMap(
      (games) => games.map((g) => g.plays / Math.max(1, g.drives)))),
    walk: countSplit([...walk.sides.values()].flatMap(
      (games) => games.map((g) => g.plays / Math.max(1, g.drives)))),
  });
  add("the side's run share", "of calls", {
    real: pool(real.sides, (g) => rateSplit(runShare(g))),
    walk: pool(walk.sides, (g) => rateSplit(runShare(g))),
  });
  add("the side's yards a play", "yards", {
    real: pool(real.sides, (g) => meanSplit(sideYards(g))),
    walk: pool(walk.sides, (g) => meanSplit(sideYards(g))),
  });
  add("the side's giveaways", "a play", {
    real: pool(real.sides, (g) => rateSplit(givenAway(g))),
    walk: pool(walk.sides, (g) => rateSplit(givenAway(g))),
  });
  add("the passer's completion rate", "of throws", {
    real: pool(real.passers, (g) => rateSplit(completions(g))),
    walk: pool(walk.passers, (g) => rateSplit(completions(g))),
  });

  for (const pos of POSITIONS) {
    const his = new Set([...keep].filter((id) => position.get(id) === pos));
    const mean = middle([...his].map((id) => middle(touchesOf.get(id) ?? [0])));
    const yards = {
      real: pool(real.men, (g) => meanSplit(manYards(g)), his),
      walk: pool(walk.men, (g) => meanSplit(manYards(g)), his),
    };
    const scores = {
      real: pool(real.men, (g) => rateSplit(manScores(g)), his),
      walk: pool(walk.men, (g) => rateSplit(manScores(g)), his),
    };
    add(
      `${pos} yards a touch`, "yards", yards,
      yards.real && yards.walk
        ? 0.1 * mean * (yards.real.gameLevel - yards.walk.gameLevel)
        : undefined,
    );
    add(
      `${pos} scores a touch`, "a touch", scores,
      scores.real && scores.walk
        ? 6 * mean * (scores.real.gameLevel - scores.walk.gameLevel)
        : undefined,
    );
  }

  report(rows);
  console.log(
    `\n  a back takes ${backShare.toFixed(3)} of ${sidePlays.toFixed(1)} snaps ` +
    `at ${yardsAPlay.toFixed(2)} yards a play` +
    "\n\n  the same rows in full" +
    "\n                                        really              " +
    "    the walk" +
    "\n                                    all   flips     game" +
    "      all   flips     game",
  );

  for (const row of rows) {
    console.log(
      `  ${row.what.padEnd(30)}` +
      `${shown(row.real, "total")}${shown(row.real, "flips")}` +
      `${shown(row.real, "gameLevel")}${shown(row.walk, "total")}` +
      `${shown(row.walk, "flips")}${shown(row.walk, "gameLevel")}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

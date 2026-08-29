/**
 * Can the walk project a week of player scoring?
 *
 * The weekly view is a ridge over recent form and the matchup, and the
 * walk has never been asked the same question. Each tested week
 * rebuilds the world as it looked that Tuesday, plays that week's
 * fixtures, and averages each man's box scores into a projection. The
 * score is Spearman against the points really scored that week, pooled
 * across weeks, next to the answer "every week is his average so far",
 * which is the same yardstick the weekly ridge was proven against.
 *
 * Run: npx tsx scripts/walkWeeklyEval.ts [seasons, comma separated]
 */

import { buildWorld } from "../src/features/playedWorld.js";
import { sizeOf } from "../src/features/gameSize.js";
import { playGame, linesFrom, type Side } from "../src/model/gameFromDrives.js";
import {
  weeklyExamplesForSeason, weeklyProspectiveForWeek, weeklyRow,
} from "../src/features/weeklyModel.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { loadPlayerStats, loadGames } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import { spearman } from "../src/backtest/metrics.js";
import { acrossCores, myShare } from "../src/sim/acrossCores.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = (process.env["SEASONS_ARG"] ?? process.argv[2] ?? "2024,2025")
  .split(",").map(Number);
const WEEKS = [3, 5, 7, 9, 11, 13, 15, 17];
const RUNS = Number(process.env["RUNS"] ?? 10);
const RULES = presets.ppr;
const POSITIONS = ["QB", "RB", "WR", "TE"];

interface PlayerWeek {
  walk: number;
  average: number;
  was: number;
  position: string;
  /** the volume half on its own, to tell it apart from conversion */
  walkTouches: number;
  wasTouches: number;
  /** and the touchdowns, the loudest part of conversion */
  walkTd: number;
  wasTd: number;
  /** what the weekly ridge says for the same man, when it has a row */
  ridge?: number;
}

/**
 * The ridge the weekly view used before the walk, fitted the way
 * start.ts fits it, once per asked season.
 */
const ridges = new Map<number, number[]>();

async function ridgeFor(season: number) {
  const already = ridges.get(season);

  if (already) {
    return already;
  }

  const games = await loadGames();
  const train = [];

  for (let s = 2016; s < season; s++) {
    train.push(...(await weeklyExamplesForSeason(s, games)));
  }

  const weights = fitRidge(
    train.map(weeklyRow), train.map((e) => e.target), 25,
  );
  ridges.set(season, weights);

  return weights;
}

const games = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));

const asShare = process.env["SHARE"] !== undefined;
const jobs = SEASONS.flatMap((season) => WEEKS.map((week) => ({ season, week })));
const mine = new Set(myShare(jobs.map((_, i) => i)));

async function oneWeek(season: number, week: number): Promise<PlayerWeek[]> {
  const positions = new Map<string, string>();
  const weekly =
    new Map<string, {
      week: number; points: number; touches: number; tds: number;
    }[]>();

  for (const s of await loadPlayerStats(season)) {
    positions.set(s.playerId, s.position);
    weekly.set(s.playerId, [
      ...(weekly.get(s.playerId) ?? []),
      {
        week: s.week,
        points: fantasyPoints(s.statLine, RULES),
        touches: (s.carries ?? 0) + (s.targets ?? 0),
        tds: (s.statLine.rushTd ?? 0) + (s.statLine.recTd ?? 0),
      },
    ]);
  }

  const world = await buildWorld(season, week, true, positions);
  const weights = await ridgeFor(season);
  const slate = await weeklyProspectiveForWeek(season, week, await loadGames());
  const ridgeSays = new Map<string, number>();

  for (const e of slate) {
    ridgeSays.set(e.playerId, predictRidge(weights, weeklyRow(e)));
  }

  const walked = new Map<string, number>();
  const walkedTouches = new Map<string, number>();
  const walkedTds = new Map<string, number>();
  let played = 0;

  for (const r of games) {
    if (Number(r["season"]) !== season || Number(r["week"]) !== week ||
        r["game_type"] !== "REG") {
      continue;
    }

    const home = world.sideFor(r["home_team"]!) as Side | null;
    const away = world.sideFor(r["away_team"]!) as Side | null;

    if (!home || !away) {
      continue;
    }

    played++;
    /**
     * The market sizes the afternoon and the walk splits it, which is
     * how the week report already serves these numbers: the walk
     * ranks a team's points at about .12 where the line ranks it at
     * .39, so a projection without the bend is not the one shown.
     */
    const total = Number(r["total_line"]);
    const spread = Number(r["spread_line"]);
    const bendFor = new Map<string, number>();

    if (Number.isFinite(total) && Number.isFinite(spread)) {
      for (const id of home.among) {
        bendFor.set(id, sizeOf({ total, favouredBy: spread }));
      }

      for (const id of away.among) {
        bendFor.set(id, sizeOf({ total, favouredBy: -spread }));
      }
    }

    for (let run = 0; run < RUNS; run++) {
      const rng = seededRng(
        season * 1000 + week * 37 +
        (r["home_team"]!.charCodeAt(0) * 131 + r["away_team"]!.charCodeAt(1)) +
        run * 7919,
      );
      const game = playGame(home, away, {
        rules: { ...world.rules, kickSucceeds: world.kicking.kickSucceeds },
        fourth: world.fourth,
        clock: { isLast: world.kicking.isLast, lastLength: world.kicking.lastLength },
        ticking: world.ticking, season, week,
      }, rng);

      for (const [id, line] of linesFrom(game, [home, away])) {
        walked.set(
          id,
          (walked.get(id) ?? 0) +
            (bendFor.get(id) ?? 1) * fantasyPoints(line, RULES) / RUNS,
        );
        walkedTouches.set(
          id,
          (walkedTouches.get(id) ?? 0) +
            ((line.carries ?? 0) + (line.targets ?? 0)) / RUNS,
        );
        walkedTds.set(
          id,
          (walkedTds.get(id) ?? 0) + (line.rushTd + line.recTd) / RUNS,
        );
      }
    }
  }

  const out: PlayerWeek[] = [];

  for (const [id, mean] of walked) {
    const position = positions.get(id) ?? "";

    if (!POSITIONS.includes(position)) {
      continue;
    }

    const his = weekly.get(id) ?? [];
    const now = his.find((w) => w.week === week);
    const before = his.filter((w) => w.week < week);

    if (!now || before.length < 2) {
      continue;
    }

    out.push({
      walk: mean,
      average: before.reduce((s, w) => s + w.points, 0) / before.length,
      was: now.points,
      position,
      walkTouches: walkedTouches.get(id) ?? 0,
      wasTouches: now.touches,
      walkTd: walkedTds.get(id) ?? 0,
      wasTd: now.tds,
      ridge: ridgeSays.get(id),
    });
  }

  if (!asShare) {
    console.error(`  ${season} week ${week}: ${played} fixtures, ${out.length} men`);
  }

  return out;
}

if (!asShare) {
  const printed = await acrossCores({
    script: import.meta.filename,
    env: { RUNS: String(RUNS), SEASONS_ARG: SEASONS.join(",") },
  });
  const pooled: PlayerWeek[] = [];

  for (const lineOut of printed) {
    pooled.push(...(JSON.parse(lineOut) as PlayerWeek[]));
  }

  const score = (rows: PlayerWeek[], label: string) => {
    if (rows.length < 20) {
      return;
    }

    const walk = spearman(rows.map((r) => r.walk), rows.map((r) => r.was));
    const avg = spearman(rows.map((r) => r.average), rows.map((r) => r.was));
    console.log(
      `${label.padEnd(6)} ${String(rows.length).padStart(5)} weeks of a man: ` +
      `walk ${walk.toFixed(3)}  his average ${avg.toFixed(3)}`,
    );
  };

  score(pooled, "all");

  for (const position of POSITIONS) {
    score(pooled.filter((r) => r.position === position), position);
  }

  /**
   * The men a lineup decision is about. Sorting starters above men who
   * barely play is easy and flatters every column, so the hard
   * question is asked apart: among men averaging double digits, who
   * has the better week?
   */
  const starters = pooled.filter((r) => r.average >= 10);
  console.log("men averaging ten or more:");
  score(starters, "all");

  for (const position of POSITIONS) {
    score(starters.filter((r) => r.position === position), position);
  }

  // the ridge the weekly view used before the walk, on the same men
  console.log("against the weekly ridge, the men it also priced:");

  for (const position of ["all", ...POSITIONS]) {
    const rows = starters.filter((r) =>
      r.ridge !== undefined && (position === "all" || r.position === position));

    if (rows.length < 20) {
      continue;
    }

    const walk = spearman(rows.map((r) => r.walk), rows.map((r) => r.was));
    const ridge = spearman(rows.map((r) => r.ridge!), rows.map((r) => r.was));
    console.log(
      `${position.padEnd(6)} ${String(rows.length).padStart(5)}: ` +
      `walk ${walk.toFixed(3)}  ridge ${ridge.toFixed(3)}`,
    );
  }

  // the volume half alone: does the walk know who gets the ball,
  // apart from what they do with it?
  console.log("their touches, same men:");

  for (const position of ["RB", "WR", "TE"]) {
    const rows = starters.filter((r) => r.position === position);

    if (rows.length < 20) {
      continue;
    }

    const walk = spearman(
      rows.map((r) => r.walkTouches), rows.map((r) => r.wasTouches));
    const flat = spearman(
      rows.map((r) => r.average), rows.map((r) => r.wasTouches));
    console.log(
      `${position.padEnd(6)} walk touches ${walk.toFixed(3)}  ` +
      `his points average as a stand-in ${flat.toFixed(3)}`,
    );
  }

  console.log("their touchdowns, same men:");

  for (const position of ["RB", "WR", "TE"]) {
    const rows = starters.filter((r) => r.position === position);

    if (rows.length < 20) {
      continue;
    }

    const walk = spearman(
      rows.map((r) => r.walkTd), rows.map((r) => r.wasTd));
    const flat = spearman(
      rows.map((r) => r.average), rows.map((r) => r.wasTd));
    console.log(
      `${position.padEnd(6)} walk tds ${walk.toFixed(3)}  ` +
      `his points average as a stand-in ${flat.toFixed(3)}`,
    );
  }
} else {
  const collected: PlayerWeek[] = [];

  for (let i = 0; i < jobs.length; i++) {
    if (!mine.has(i)) {
      continue;
    }

    collected.push(...await oneWeek(jobs[i]!.season, jobs[i]!.week));
  }

  console.log(JSON.stringify(collected));
}

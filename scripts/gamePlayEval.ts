/**
 * A game played out, against one assembled from parts.
 *
 * The box score eval hands each side a number of drives drawn from
 * what teams get, and a starting spot drawn from where drives start,
 * and walks the two of them separately. This plays them against each
 * other until the clock runs out, so both come from the game instead.
 *
 * Run: npx tsx scripts/gamePlayEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { fitSwings } from "../src/features/fitSwing.js";
import { fitEndings } from "../src/features/fitEndings.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import { fitFourthDown, type FourthRow } from "../src/features/fitFourthDown.js";
import { fitPlayClock, timeBetween } from "../src/features/fitPlayClock.js";
import { divideAmong } from "../src/features/shareCompetition.js";
import { buildMatchupTable } from "../src/features/matchupTable.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { loadCoaches } from "../src/data/coaches.js";
import { sizeOf } from "../src/features/gameSize.js";
import { weatherLift } from "../src/features/weatherLift.js";
import { loadDriveStarts, startFrom } from "../src/features/driveStarts.js";
import { walkDrive } from "../src/model/driveFromFactors.js";
import {
  playGame, GAME_DEFAULTS, type Side,
} from "../src/model/gameFromDrives.js";
import { myShare } from "../src/sim/acrossCores.js";
import type { Call } from "../src/model/playFactors.js";

/** the fourth downs where a side actually chose, so not the flags */
const DECIDED = ["run", "pass", "field_goal", "punt"];

const SCORE_ON = 2025;
const LEARN = [2021, 2022, 2023, 2024];
const RUNS = Number(process.env["RUNS"] ?? 40);

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Truth {
  week: number;
  team: string;
  against: string;
  home: boolean;
  points: number;
}

async function main(): Promise<void> {
  const raw = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const learnRows = timeBetween(
    raw.filter((r) => Number(r["season"]) < SCORE_ON).map((r) => ({
      season: Number(r["season"]), week: Number(r["week"]),
      offence: r["offense"] ?? "", defence: r["defense"] ?? "",
      down: Number(r["down"]), toGo: Number(r["togo"]),
      yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
      secondsLeft: Number(r["seconds"]) || 1800,
      call: (r["playType"] ?? "") as Call,
      yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
      player: r["player"] ?? "", passer: r["passer"] ?? "",
      airYards: r["airYards"] === "" || r["airYards"] === undefined
        ? undefined : Number(r["airYards"]),
    })),
  );
  const staffing = await loadCoaches();
  const stillThere = (role: string) => (offence: string) =>
    (staffing.get(`${offence}|${SCORE_ON}|${role}`) ?? "a") ===
      (staffing.get(`${offence}|${SCORE_ON - 1}|${role}`) ?? "b");
  const ticking = fitPlayClock(
    process.env["NO_PACE"] ? learnRows.map((r) => ({ ...r, offence: "" })) : learnRows,
    400,
    {
      sameHeadCoach: stillThere("HC"),
      sameCoordinator: stillThere("OC"),
    },
  );
  console.error(`the clock learned on ${ticking.learnedOn} plays`);

  const positions = new Map<string, string>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  const swings = await fitSwings(SCORE_ON - 1, positions);
  const { byTeam } = await fitRoles(SCORE_ON - 1, positions, played, 17, undefined, swings);
  const rules = await fitDriveRules(LEARN);
  const kicking = await fitEndings(LEARN);
  const picks = await loadDraftPicks();

  const fourths = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "fourths.csv"), "utf8",
  )).filter((r) =>
    Number(r["season"]) < SCORE_ON && Number(r["down"]) === 4 &&
    DECIDED.includes(r["playType"] ?? ""));
  const fourth = fitFourthDown(fourths.map((r) => ({
    toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
    choice: ["run", "pass"].includes(r["playType"] ?? "") ? "go"
      : r["playType"] === "field_goal" ? "kick" : "punt",
  })) as FourthRow[]);

  // each man's expected share, from the competition among his team
  const lastYear = new Map<string, number>();
  const teamPlays = new Map<string, number>();

  for (const r of raw.filter((x) => Number(x["season"]) === SCORE_ON - 1)) {
    const team = r["offense"] ?? "";
    teamPlays.set(team, (teamPlays.get(team) ?? 0) + 1);
    if (r["player"]) lastYear.set(r["player"]!, (lastYear.get(r["player"]!) ?? 0) + 1);
  }

  const projected = new Map<string, number>();
  const total: Record<string, number> = { RB: 0.31, WR: 0.33, TE: 0.11 };
  const asRookie: Record<string, number> = { RB: 0.09, WR: 0.06, TE: 0.03 };

  for (const [team, roster] of byTeam) {
    for (const spot of ["RB", "WR", "TE"]) {
      const group = roster.filter((p) => p.position === spot);
      if (!group.length) continue;
      const shares = divideAmong(
        group.map((p) => {
          const had = lastYear.get(p.playerId) ?? 0;
          return {
            playerId: p.playerId,
            standing: had > 0
              ? had / Math.max(1, teamPlays.get(team) ?? 1000)
              : picks.has(p.playerId) ? asRookie[spot]! : 0.005,
          };
        }),
        total[spot]!,
      );
      for (const [id, share] of shares) projected.set(id, share);
    }
  }

  const pairing = process.env["NO_MATCHUP"]
    ? undefined
    : await buildMatchupTable({ learn: LEARN.slice(-3), scoreOn: SCORE_ON });
  const factors = fitPlayFactors(learnRows as PlayRow[], undefined, {
    projected, pairing: pairing?.bend,
  });

  // who threw for each side last season
  const attempts = new Map<string, Map<string, number>>();

  for (const r of raw.filter((x) => Number(x["season"]) === SCORE_ON - 1)) {
    if (r["playType"] !== "pass" || !r["passer"]) continue;
    const team = r["offense"] ?? "";
    const own = attempts.get(team) ?? new Map<string, number>();
    own.set(r["passer"]!, (own.get(r["passer"]!) ?? 0) + 1);
    attempts.set(team, own);
  }

  const throwsFor = new Map<string, string>();

  for (const [team, own] of attempts) {
    const most = [...own.entries()].sort((a, b) => b[1] - a[1])[0];
    if (most) throwsFor.set(team, most[0]);
  }

  // what really happened, and how many drives each side really got
  const scored = new Map<string, Truth>();
  const reallyDrove = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON || Number(row["week"]) > 18) continue;
    const key = `${row["week"]}|${row["offense"]}`;
    const own = scored.get(key) ?? {
      week: Number(row["week"]), team: row["offense"] ?? "",
      against: row["defense"] ?? "", home: false, points: 0,
    };
    own.points += Number(row["points"]);
    scored.set(key, own);
    reallyDrove.set(key, (reallyDrove.get(key) ?? 0) + 1);
  }

  const line = new Map<string, number>();
  const homeSide = new Set<string>();
  // the fixture behind each side's week, so the day can be looked up
  const fixtureOf = new Map<string, Awaited<ReturnType<typeof loadGames>>[number]>();

  for (const game of await loadGames()) {
    if (game.season !== SCORE_ON || game.week > 18) continue;
    homeSide.add(`${game.week}|${game.homeTeamId}`);
    fixtureOf.set(`${game.week}|${game.homeTeamId}`, game);
    fixtureOf.set(`${game.week}|${game.awayTeamId}`, game);
    const t = game.totalLine;
    const s = game.spreadLine;
    if (t === undefined || s === undefined) continue;
    line.set(`${game.week}|${game.homeTeamId}`, t / 2 + s / 2);
    line.set(`${game.week}|${game.awayTeamId}`, t / 2 - s / 2);
  }

  const sideFor = (team: string): Side | undefined => {
    const roster = byTeam.get(team);

    if (!roster) {
      return undefined;
    }

    return {
      team, factors, passer: throwsFor.get(team),
      // with nobody named, a play gains what the league gains, which
      // is how the drive shape was checked in the first place
      among: process.env["NOBODY"]
        ? [""]
        : roster.filter((p) => positions.has(p.playerId)).map((p) => p.playerId),
    };
  };

  const drawnStarts = await loadDriveStarts([2022, 2023, 2024]);
  const everyDrive = {
    plays: 0, seconds: 0, count: 0, startedAt: 0,
    starts: [] as number[],
    ends: new Map<string, number>(),
  };
  const rng = seededRng(Number(process.env["SEED"] ?? 23));
  const said = new Map<string, { points: number; drives: number }>();
  const seen = new Set<string>();

  const only = Number(process.env["GAMES"] ?? 0);
  const mine = new Set(
    myShare([...scored.keys()].filter((key) => homeSide.has(key))),
  );

  for (const [key, truth] of scored) {
    if (!homeSide.has(key) || seen.has(key) || !mine.has(key)) {
      continue;
    }

    if (only && seen.size >= only) {
      break;
    }

    const home = sideFor(truth.team);
    const away = sideFor(truth.against);

    if (!home || !away) {
      continue;
    }

    /**
     * How far the walk bends toward the market's implied total.
     * Seven tenths won the sweep: most of the line's ordering (.35 of
     * its .39, from .135 unbent) and the only strength that also
     * improved the points error. A full bend inflated scoring until
     * the error was worse than not listening at all.
     */
    const alpha = Number(process.env["ALPHA"] ?? 0.7);

    if (alpha > 0) {
      home.lift = Math.pow(
        sizeOf({
          total: 2 * ((line.get(key) ?? 22.4)),
          favouredBy: 0,
        }), alpha,
      );
      const theirKey = `${truth.week}|${truth.against}`;
      away.lift = Math.pow(
        sizeOf({ total: 2 * (line.get(theirKey) ?? 22.4), favouredBy: 0 }),
        alpha,
      );
    }

    /**
     * The day, for a fixture with no line on it. The market prices the
     * weather already, so bending toward the line and then charging for
     * the cold on top would count it twice.
     */
    if (process.env["WEATHER"]) {
      const fixture = fixtureOf.get(key);
      const day = fixture
        ? {
            indoors: fixture.indoors,
            temperature: fixture.temp,
            wind: fixture.wind,
          }
        : { indoors: true };
      const worth = weatherLift(day);
      home.lift = (home.lift ?? 1) * worth;
      away.lift = (away.lift ?? 1) * worth;
    }

    seen.add(key);
    const tally = new Map<string, { points: number; drives: number }>();

    for (let run = 0; run < RUNS; run++) {
      const game = playGame(home, away, {
        rules: { ...rules, kickSucceeds: kicking.kickSucceeds },
        fourth,
        clock: { isLast: kicking.isLast, lastLength: kicking.lastLength },
        ticking, season: SCORE_ON, week: truth.week,
      }, rng, {
        ...GAME_DEFAULTS, frozen: Boolean(process.env["FROZEN"]),
        startsAt: process.env["DRAWN_STARTS"]
          ? (u) => startFrom(drawnStarts, u)
          : undefined,
      });

      for (const one of game.possessions) {
        everyDrive.plays += one.drive.plays.length;
        everyDrive.seconds += one.drive.took;
        everyDrive.count++;
        everyDrive.ends.set(
          one.drive.ending, (everyDrive.ends.get(one.drive.ending) ?? 0) + 1,
        );
        everyDrive.startedAt += one.startedAt;
        everyDrive.starts.push(one.startedAt);
      }

      for (const team of [home.team, away.team]) {
        const own = tally.get(team) ?? { points: 0, drives: 0 };
        own.points += game.points[team] ?? 0;
        own.drives += game.drives[team] ?? 0;
        tally.set(team, own);
      }
    }

    for (const [team, own] of tally) {
      said.set(`${truth.week}|${team}`, {
        points: own.points / RUNS, drives: own.drives / RUNS,
      });
    }
  }

  // the same factors walked the old way, eleven drives from a drawn
  // starting spot, so the two can be told apart in one process
  const alone = { plays: 0, count: 0, ends: new Map<string, number>() };
  const someSide = sideFor([...byTeam.keys()][0] ?? "");

  if (someSide) {
    const starts = await loadDriveStarts([2022, 2023, 2024]);

    for (const [how, withSides] of [
      ["nobody named on either side", false], ["with both sides named", true],
    ] as [string, boolean][]) {
      const tally = { plays: 0, count: 0, ends: new Map<string, number>() };

      const everyTeam = [...byTeam.keys()];

      for (let i = 0; i < 3000; i++) {
        const one = sideFor(everyTeam[i % everyTeam.length]!);

        if (!one) {
          continue;
        }

        const drive = walkDrive(
          startFrom(starts, rng), factors,
          { ...rules, kickSucceeds: kicking.kickSucceeds }, fourth,
          one.among, rng,
          { isLast: kicking.isLast, lastLength: kicking.lastLength },
          withSides
            ? {
                offence: everyTeam[i % everyTeam.length]!,
                defence: everyTeam[(i + 1) % everyTeam.length]!,
                season: SCORE_ON, week: 1,
              }
            : {},
          ticking,
        );
        tally.plays += drive.plays.length;
        tally.count++;
        tally.ends.set(drive.ending, (tally.ends.get(drive.ending) ?? 0) + 1);
      }

      console.log(
        `\n  one drive at a time, ${how}: ` +
          `${(tally.plays / tally.count).toFixed(1)} plays, ` +
          [...tally.ends.entries()].sort((a, b) => b[1] - a[1])
            .map(([e, n]) => `${e} ${(100 * n / tally.count).toFixed(0)}%`)
            .join(", "),
      );
    }

    for (let i = 0; i < 1; i++) {
      alone.count = 1;
      alone.plays = 0;
      alone.ends.set("skip", 1);
    }

    console.log(
      `\nthe same factors walked one drive at a time, ${alone.count} of them\n` +
        `  ${(alone.plays / alone.count).toFixed(1)} plays\n` +
        "  ends: " + [...alone.ends.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([how, n]) => `${how} ${(100 * n / alone.count).toFixed(0)}%`)
          .join(", "),
    );
  }

  const rows = [...said.entries()]
    .map(([key, guess]) => ({
      key, guess,
      truth: scored.get(key),
      drove: reallyDrove.get(key) ?? 0,
      priced: line.get(key),
    }))
    .filter((row) => row.truth && row.priced !== undefined);

  if (process.env["SHARES"]) {
    // one share of the work, so hand back what it simulated rather
    // than scoring it: only the whole season is worth scoring
    console.log(JSON.stringify({
      said: [...said.entries()],
      drive: {
        plays: everyDrive.plays, seconds: everyDrive.seconds,
        count: everyDrive.count, startedAt: everyDrive.startedAt,
        ends: [...everyDrive.ends.entries()],
      },
    }));
    return;
  }

  const sorted = [...everyDrive.starts].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  console.log(
    "\nwhere a simulated drive starts, in yards from the goal\n" +
      `  a tenth inside ${at(0.1)}, half inside ${at(0.5)}, ` +
      `a tenth beyond ${at(0.9)}, and ` +
      `${(100 * sorted.filter((y) => y >= 90).length / Math.max(1, sorted.length)).toFixed(1)}% ` +
      "start 90 or more out",
  );
  console.log(
    `\nwhat a simulated drive looks like, over ${everyDrive.count} of them\n` +
      `  ${(everyDrive.plays / everyDrive.count).toFixed(1)} plays, ` +
      `${(everyDrive.seconds / everyDrive.count).toFixed(0)} seconds, ` +
      `starting ${(everyDrive.startedAt / everyDrive.count).toFixed(0)} out\n` +
      "  ends: " + [...everyDrive.ends.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([how, n]) => `${how} ${(100 * n / everyDrive.count).toFixed(0)}%`)
        .join(", "),
  );
  console.log(`\n${rows.length} team games played out\n`);
  console.log("  what                     model   always the average   order");

  const points = rows.map((r) => r.guess.points);
  const truth = rows.map((r) => r.truth!.points);
  const flat = middle(truth);
  console.log(
    "  points" .padEnd(27) + rmse(points, truth).toFixed(2).padStart(6) +
      rmse(truth.map(() => flat), truth).toFixed(2).padStart(21) +
      spearman(points, truth).toFixed(3).padStart(8),
  );

  const drives = rows.map((r) => r.guess.drives);
  const droveReally = rows.map((r) => r.drove);
  console.log(
    "  drives".padEnd(27) + rmse(drives, droveReally).toFixed(2).padStart(6) +
      rmse(droveReally.map(() => middle(droveReally)), droveReally)
        .toFixed(2).padStart(21) +
      spearman(drives, droveReally).toFixed(3).padStart(8),
  );

  const priced = rows.map((r) => r.priced!);
  console.log(
    "  points, the line".padEnd(27) + rmse(priced, truth).toFixed(2).padStart(6) +
      "".padStart(21) + spearman(priced, truth).toFixed(3).padStart(8),
  );

  const spread = (values: number[]) => {
    const mid = middle(values);
    return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
  };

  console.log(
    `\n  the model says ${middle(points).toFixed(1)} points off ` +
      `${middle(drives).toFixed(1)} drives, ` +
      `they scored ${flat.toFixed(1)} off ${middle(droveReally).toFixed(1)}\n`,
  );
  console.log(
    "  how far apart it puts two team games, in points\n" +
      `    the model  ${spread(points).toFixed(2)}\n` +
      `    the line   ${spread(priced).toFixed(2)}\n` +
      `    what happened ${spread(truth).toFixed(2)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

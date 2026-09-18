/**
 * A season played out fixture by fixture, kept on disk.
 *
 * This writes `data/kept/played-<season>.json`, which the board reads
 * for the walk's opinion of a player and for the games it dealt him.
 * The schedule is cut into shares, one process each, and the shares
 * are merged here.
 *
 * Each pass through the season draws its own absences, so a man is
 * down for spells rather than discounted by a factor.
 *
 * Run: npx tsx scripts/playedSeason.ts 2026
 * RUNS sets the passes through the season and SHARES_WANTED the cores.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { buildWorld } from "../src/features/playedWorld.js";
import { fitAbsence } from "../src/features/fitAbsence.js";
import { fitClimate, type Reading } from "../src/features/climate.js";
import { kickingVenue } from "../src/features/kickingVenue.js";
import { sizeOf } from "../src/features/gameSize.js";
import { SHARING_POSITIONS } from "../src/features/projectedShares.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { playGame, linesFrom, type Side } from "../src/model/gameFromDrives.js";
import { seededRng } from "../src/sim/rng.js";
import { acrossCores, myShare } from "../src/sim/acrossCores.js";
import { cpus } from "node:os";

const SEASON = Number(process.argv[2] ?? process.env["SEASON"] ?? 2026);
const RUNS = Number(process.env["RUNS"] ?? 40);
const RULES = presets.ppr;

/**
 * The parts every scoring system is built out of. They use the same
 * fields as a stat line, so a reader can apply his own rules to them.
 */
const PARTS = [
  "passYds", "passTd", "interceptions", "rushYds", "rushTd",
  "receptions", "recYds", "recTd", "fumblesLost", "twoPointConversions",
  "carries", "targets", "passAtt", "passCmp",
] as const;

type StatTotals = Record<typeof PARTS[number], number>;

const blankTotals = (): StatTotals => ({
  passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0, fumblesLost: 0, twoPointConversions: 0,
  carries: 0, targets: 0, passAtt: 0, passCmp: 0,
});

interface Kicks { from: number[]; conversions: number }

/** what the drives came out at, for holding against what sides get */
interface DriveCounts {
  drives: number;
  snaps: number;
  noPlays: number;
  seconds: number;
  teamGames: number;
  runs: number;
  passes: number;
  sacks: number;
  thrownAway: number;
  ends: [string, number][];
}

const blankDrives = (): DriveCounts => ({
  drives: 0, snaps: 0, noPlays: 0, seconds: 0, teamGames: 0,
  runs: 0, passes: 0, sacks: 0, thrownAway: 0, ends: [],
});

/** what one share of the schedule sends back */
interface FromAShare {
  weeks: number;
  total: [string, number][];
  games: [string, number][];
  made: [string, StatTotals][];
  kicks: [string, Kicks][];
  samples: [string, number[]][];
  drives: DriveCounts;
}

/**
 * The market's read on a side's afternoon. Seven tenths of the way
 * there took back most of the ordering the walk alone cannot get and
 * was the only strength that also improved the points error.
 */
const ALPHA = Number(process.env["ALPHA"] ?? 0.7);

/**
 * How many fixtures a side gets, which is the weeks in the schedule
 * less its bye. Counting the weeks instead overstates it by one and
 * every kicker ends up a kick short.
 */
function fixturesEachSideGets(schedule: { homeTeamId: string; awayTeamId: string }[]): number {
  const each = new Map<string, number>();

  for (const g of schedule) {
    each.set(g.homeTeamId, (each.get(g.homeTeamId) ?? 0) + 1);
    each.set(g.awayTeamId, (each.get(g.awayTeamId) ?? 0) + 1);
  }

  const counted = [...each.values()].sort((a, b) => a - b);

  return counted[Math.floor(counted.length / 2)] ?? 17;
}

async function playMyShare(): Promise<FromAShare> {
  const positions = new Map<string, string>();

  for (const s of await loadPlayerStats(SEASON - 1)) {
    positions.set(s.playerId, s.position);
  }

  const world = await buildWorld(SEASON, 1, false, positions);
  const everyGame = await loadGames();
  const schedule = everyGame.filter(
    (g) => g.season === SEASON && g.week <= 18,
  );
  const weeks = fixturesEachSideGets(schedule);
  const mine = myShare(schedule);
  const rng = seededRng(Number(process.env["SEED"] ?? 23));

  /**
   * How many games men with his recent history play, which is what his
   * own hazard is scaled to. A man nobody has seen takes the middle.
   */
  const gamesBefore = new Map<string, number[]>();

  for (const back of [1, 2, 3]) {
    const seen = new Map<string, Set<number>>();

    for (const s of await loadPlayerStats(SEASON - back).catch(() => [])) {
      if (s.week > 18) {
        continue;
      }

      const weeksSeen = seen.get(s.playerId) ?? new Set<number>();
      weeksSeen.add(s.week);
      seen.set(s.playerId, weeksSeen);
    }

    for (const [playerId, weeksSeen] of seen) {
      gamesBefore.set(playerId, [
        ...(gamesBefore.get(playerId) ?? []), weeksSeen.size,
      ]);
    }
  }

  const absence = await fitAbsence(
    [SEASON - 4, SEASON - 3, SEASON - 2, SEASON - 1],
  );
  const expectedFor = (playerId: string) => {
    const his = gamesBefore.get(playerId) ?? [];
    const mean = his.length ? his.reduce((a, b) => a + b, 0) / his.length : 15;
    const trust = his.length / (his.length + 1);

    return trust * mean + (1 - trust) * 15;
  };
  const seedOf = (playerId: string, run: number) => {
    let hash = SEASON * 31 + run * 7919;

    for (let i = 0; i < playerId.length; i++) {
      hash = (hash * 131 + playerId.charCodeAt(i)) | 0;
    }

    return hash >>> 0;
  };
  /**
   * Seeded by the man and the pass alone, so every share of the job
   * gets the same answer for a week, and one pass through the season
   * puts his absences in spells the way a season does.
   */
  const outRemembered = new Map<string, Set<number>>();
  const outWeeks = (playerId: string, position: string, run: number) => {
    const key = `${playerId}|${run}`;
    const already = outRemembered.get(key);

    if (already) {
      return already;
    }

    const draws = seededRng(seedOf(playerId, run));
    const hazard = absence.hazardFor(position, expectedFor(playerId), 17);
    const out = new Set<number>();
    let downFor = 0;

    for (let week = 1; week <= 18; week++) {
      if (downFor > 0) {
        out.add(week);
        downFor--;
        continue;
      }

      if (draws() < hazard) {
        out.add(week);
        downFor = absence.spellOf(position, draws) - 1;
      }
    }

    outRemembered.set(key, out);

    return out;
  };

  /**
   * Every reading there has ever been, so a fixture nobody has played
   * can still be given a day. Fitted on seasons before this one, so
   * nothing reads its own weather.
   */
  const climate = fitClimate(
    everyGame
      .filter((g) => g.season < SEASON && !g.indoors &&
        g.temp !== undefined && g.week <= 18)
      .map((g): Reading => ({
        team: g.homeTeamId, week: g.week, hour: g.hour ?? 13,
        temperature: g.temp!, wind: g.wind,
      })),
  );

  const total = new Map<string, number>();
  const games = new Map<string, number>();
  const madeOf = new Map<string, StatTotals>();
  const samples = new Map<string, number[]>();
  const kicksFor = new Map<string, Kicks>();
  const drove = blankDrives();
  const ends = new Map<string, number>();

  for (const fixture of mine) {
    const home = world.sideFor(fixture.homeTeamId);
    const away = world.sideFor(fixture.awayTeamId);

    if (!home || !away) {
      continue;
    }

    if (ALPHA > 0 &&
        fixture.totalLine !== undefined && fixture.spreadLine !== undefined) {
      home.lift = Math.pow(sizeOf(
        { total: fixture.totalLine, favouredBy: fixture.spreadLine },
      ), ALPHA);
      away.lift = Math.pow(sizeOf(
        { total: fixture.totalLine, favouredBy: -fixture.spreadLine },
      ), ALPHA);
    }

    /**
     * A season nobody has played has no readings, so a day is drawn
     * for it once a run rather than once a fixture, and the walk sees
     * a mild December afternoon in Buffalo as often as a freezing one.
     */
    const drawVenue = () => ({
      indoors: fixture.indoors,
      temperature: fixture.temp ?? (fixture.indoors
        ? undefined
        : climate.drawTemperature(
            fixture.homeTeamId, fixture.week, fixture.hour ?? 13, rng,
          )),
      wind: fixture.wind ?? (fixture.indoors
        ? undefined
        : climate.drawWind(fixture.homeTeamId, rng)),
    });
    const meanFor = new Map<string, number>();
    const madeThisGame = new Map<string, StatTotals>();

    for (let run = 0; run < RUNS; run++) {
      const venue = drawVenue();
      drove.teamGames += 2;
      /**
       * The men down this week of this pass leave the field, and the
       * shares renormalise over whoever is left.
       */
      const upNow = (side: Side): Side => {
        const among = side.among.filter((id) =>
          !SHARING_POSITIONS.includes(positions.get(id) ?? "") ||
          !outWeeks(id, positions.get(id)!, run).has(fixture.week));

        return among.length === side.among.length ? side : { ...side, among };
      };
      const homeNow = upNow(home);
      const awayNow = upNow(away);
      const game = playGame(homeNow, awayNow, {
        rules: {
          ...world.rules, kickSucceeds: world.kicking.kickSucceeds,
          kickHere: (yardline: number) => kickingVenue.bend(yardline, venue),
          kickAppetite: kickingVenue.appetite(venue),
        },
        fourth: world.fourth,
        clock: {
          isLast: world.kicking.isLast, lastLength: world.kicking.lastLength,
        },
        ticking: world.ticking, season: SEASON, week: fixture.week,
      }, rng);

      for (const [playerId, line] of linesFrom(game, [homeNow, awayNow])) {
        const points = fantasyPoints(line, RULES);
        meanFor.set(playerId, (meanFor.get(playerId) ?? 0) + points / RUNS);
        // every game he was dealt, kept whole, so his spread on the
        // card can be his own rather than a pooled band's
        const his = samples.get(playerId) ?? [];
        his.push(Math.round(points * 10) / 10);
        samples.set(playerId, his);
        const made = madeThisGame.get(playerId) ?? blankTotals();

        for (const part of PARTS) {
          made[part] += (line[part] ?? 0) / RUNS;
        }

        madeThisGame.set(playerId, made);
      }

      for (const one of game.possessions) {
        drove.drives++;
        drove.seconds += one.drive.took;
        ends.set(one.drive.ending, (ends.get(one.drive.ending) ?? 0) + 1);

        for (const play of one.drive.plays) {
          if (play.unaimed === "flag") {
            drove.noPlays++;
            continue;
          }

          drove.snaps++;

          if (play.call === "run") {
            drove.runs++;
            continue;
          }

          drove.passes++;

          if (play.unaimed === "sack") {
            drove.sacks++;
          }

          if (play.unaimed === "away") {
            drove.thrownAway++;
          }
        }

        const its = kicksFor.get(one.team) ?? { from: [], conversions: 0 };

        if (one.drive.kickedFrom !== undefined) {
          its.from.push(one.drive.kickedFrom);
        }

        if (one.drive.ending === "touchdown") {
          its.conversions += 1 / RUNS;
        }

        kicksFor.set(one.team, its);
      }
    }

    for (const [playerId, points] of meanFor) {
      total.set(playerId, (total.get(playerId) ?? 0) + points);
      games.set(playerId, (games.get(playerId) ?? 0) + 1);
    }

    for (const [playerId, made] of madeThisGame) {
      const soFar = madeOf.get(playerId) ?? blankTotals();

      for (const part of PARTS) {
        soFar[part] += made[part];
      }

      madeOf.set(playerId, soFar);
    }
  }

  return {
    weeks,
    total: [...total.entries()],
    games: [...games.entries()],
    made: [...madeOf.entries()],
    kicks: [...kicksFor.entries()],
    samples: [...samples.entries()],
    drives: { ...drove, ends: [...ends.entries()] },
  };
}

function report(drove: DriveCounts): void {
  const perTeamGame = (n: number) => n / Math.max(1, drove.teamGames);
  console.error(
    `\nwhat the walk's drives came out at, over ${drove.drives} of them\n` +
    `  ${(drove.snaps / Math.max(1, drove.drives)).toFixed(2)} snaps and ` +
    `${(drove.seconds / Math.max(1, drove.drives)).toFixed(0)} seconds a drive\n` +
    `  ${perTeamGame(drove.drives).toFixed(2)} drives and ` +
    `${perTeamGame(drove.snaps).toFixed(1)} snaps a team game, ` +
    `${perTeamGame(drove.noPlays).toFixed(1)} of them wiped out by a flag\n` +
    `  ${perTeamGame(drove.runs).toFixed(1)} runs, ` +
    `${perTeamGame(drove.passes).toFixed(1)} pass plays, of which ` +
    `${perTeamGame(drove.sacks).toFixed(2)} sacked and ` +
    `${perTeamGame(drove.thrownAway).toFixed(2)} thrown away\n` +
    "  ends: " + drove.ends
      .sort((a, b) => b[1] - a[1])
      .map(([how, n]) => `${how} ${(100 * n / drove.drives).toFixed(0)}%`)
      .join(", "),
  );
}

async function main(): Promise<void> {
  if (process.env["SHARE"] !== undefined) {
    console.log(JSON.stringify(await playMyShare()));
    return;
  }

  const shares = Number(process.env["SHARES_WANTED"]) ||
    Math.max(1, Math.min(8, cpus().length - 2));
  console.error(
    `playing ${SEASON} over ${shares} cores, ${RUNS} passes through it`,
  );
  const printed = await acrossCores({
    script: import.meta.filename,
    shares,
    env: { SEASON: String(SEASON), RUNS: String(RUNS) },
    asTheyLand: (share) => console.error(`  share ${share} back`),
  });

  const total = new Map<string, number>();
  const games = new Map<string, number>();
  const madeOf = new Map<string, StatTotals>();
  const samples = new Map<string, number[]>();
  const kicksFor = new Map<string, Kicks>();
  const drove = blankDrives();
  const ends = new Map<string, number>();
  let weeks = 0;

  for (const line of printed) {
    const from = JSON.parse(line) as FromAShare;
    weeks = from.weeks;

    for (const [playerId, points] of from.total) {
      total.set(playerId, (total.get(playerId) ?? 0) + points);
    }

    for (const [playerId, n] of from.games) {
      games.set(playerId, (games.get(playerId) ?? 0) + n);
    }

    for (const [playerId, his] of from.samples) {
      samples.set(playerId, [...(samples.get(playerId) ?? []), ...his]);
    }

    for (const [playerId, made] of from.made) {
      const soFar = madeOf.get(playerId) ?? blankTotals();

      for (const part of PARTS) {
        soFar[part] += made[part] ?? 0;
      }

      madeOf.set(playerId, soFar);
    }

    for (const [team, its] of from.kicks) {
      const already = kicksFor.get(team) ?? { from: [], conversions: 0 };
      already.from.push(...its.from);
      already.conversions += its.conversions;
      kicksFor.set(team, already);
    }

    drove.drives += from.drives.drives;
    drove.snaps += from.drives.snaps;
    drove.noPlays += from.drives.noPlays;
    drove.seconds += from.drives.seconds;
    drove.teamGames += from.drives.teamGames;
    drove.runs += from.drives.runs;
    drove.passes += from.drives.passes;
    drove.sacks += from.drives.sacks;
    drove.thrownAway += from.drives.thrownAway;

    for (const [how, n] of from.drives.ends) {
      ends.set(how, (ends.get(how) ?? 0) + n);
    }
  }

  drove.ends = [...ends.entries()];
  report(drove);

  const at = join(
    import.meta.dirname, "..", "data", "kept", `played-${SEASON}.json`,
  );
  await writeFile(at, JSON.stringify({
    runs: RUNS, weeks,
    total: [...total.entries()],
    games: [...games.entries()],
    made: [...madeOf.entries()],
    kicks: [...kicksFor.entries()],
    samples: [...samples.entries()],
  }));
  console.error(`\nwrote ${madeOf.size} players to ${at}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * The fitted world, reduced to tables a browser can replay a game from.
 *
 * The Node simulator asks the fitted model a question on every snap:
 * how often does this side run here, who gets the ball, how far does
 * he take it. None of that fits in a static site, so the questions are
 * asked here on a grid and the answers are written out as bytes.
 *
 * The grid throws away two things. What a side lines up in no longer
 * moves what it then calls, and a man's gains are sampled at one spot
 * and scaled to the rest of the field.
 *
 * Run: npx tsx scripts/buildSimTables.ts [season] [week]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildWorld } from "../src/features/playedWorld.js";
import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import { DEFAULT_AFTER_TOUCHDOWN } from "../src/features/afterTouchdown.js";
import type { Call, PlayState } from "../src/model/playFactors.js";
import { seededRng } from "../src/sim/rng.js";
import {
  DIST_BANDS, FIELD_BANDS, MARGIN_BANDS, QUANTILES, TIME_BANDS, YARD_OFFSET,
  type SimTables,
} from "../app/lib/simTables.ts";

const SEASON = Number(process.argv[2] ?? new Date().getFullYear());
const WEEK = Number(process.argv[3] ?? 1);
const SAMPLES = Number(process.env["SIM_TABLE_SAMPLES"] ?? 4000);

const normalizeName = (name: string) =>
  name
    .normalize("NFD")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?$/, "")
    .replace(/[^a-z]/g, "");

const clampByte = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value)));

const asBytes = (values: number[]) =>
  Buffer.from(Uint8Array.from(values.map(clampByte))).toString("base64");

/** a rate written as a byte, which costs two parts in a thousand */
const rateByte = (rate: number) => clampByte(rate * 255);

const DOWNS = [1, 2, 3, 4];
const DIST_MID = [1, 5, 8, 14];
const FIELD_MID = [5, 15, 35, 65, 90];
const MARGIN_MID = [-14, -6, -1, 0, 1, 6, 14];
const TIME_MID = [2400, 1200, 600, 200];

const stateAt = (
  down: number, dist: number, field: number, margin: number, time: number,
): PlayState => ({
  down, toGo: Math.min(DIST_MID[dist]!, FIELD_MID[field]!),
  yardline: FIELD_MID[field]!, margin: MARGIN_MID[margin]!,
  secondsLeft: TIME_MID[time]!,
});

/** the quantiles of a sample, as bytes with the yard offset on them */
function quantilesOf(drawn: number[]): number[] {
  if (!drawn.length) {
    return new Array(QUANTILES).fill(clampByte(YARD_OFFSET)) as number[];
  }

  const sorted = [...drawn].sort((a, b) => a - b);

  return Array.from({ length: QUANTILES }, (_, i) => {
    const at = Math.min(sorted.length - 1,
      Math.floor(((i + 0.5) / QUANTILES) * sorted.length));

    return clampByte(sorted[at]! + YARD_OFFSET);
  });
}

async function main(): Promise<void> {
  const positions = new Map<string, string>();
  const nameOf = new Map<string, string>();

  for (const row of await loadPlayerStats(SEASON - 1)) {
    positions.set(row.playerId, row.position);
    nameOf.set(row.playerId, row.playerName);
  }

  for (const row of await loadPlayerStats(SEASON)) {
    positions.set(row.playerId, row.position);
    nameOf.set(row.playerId, row.playerName);
  }

  const rosters = await loadWeeklyRosters(SEASON);
  const byWeek = new Map<number, Set<string>>();

  for (const row of rosters) {
    const already = byWeek.get(row.week) ?? new Set<string>();
    byWeek.set(row.week, already);
    already.add(row.teamId);
  }

  const playedIn = (week: number) => byWeek.get(week) ?? new Set<string>();
  const everyTeam = [...new Set(rosters.map((row) => row.teamId))].sort();
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  const nearestWeeks = (from: number) =>
    weeks.filter((week) => week !== from)
      .sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || b - a);

  const world = await buildWorld(
    SEASON, WEEK, true, positions, { componentShares: true });
  const positionOf = new Map<string, string>(positions);

  for (const men of world.onTeam.values()) {
    for (const man of men) {
      positionOf.set(man.playerId, man.position);
    }
  }

  const teams = [...world.onTeam.keys()].sort();
  const rng = seededRng(20260912);

  const tables: SimTables = {
    season: SEASON, week: WEEK,
    teams: {},
    league: {
      kickSucceeds: "", puntQuantiles: {}, turnover: "", secondsFor: "",
      gainScale: "", fourth: "", goesForTwo: "", twoPointRate: 0,
      extraPointRate: 0, matchup: {}, penaltyQuantiles: "", teamOrder: [],
      rules: {
        penaltyFirstDown: 0, offenceFlag: 0, defenceFlag: 0, maxPlays: 20,
        isLast: 0.071,
      },
    },
  };

  const neutral = { down: 0, dist: 2, field: 3, margin: 3, time: 0 };
  const gainScale: number[] = [];
  const poolMeanAt = (call: Call, down: number, dist: number, field: number) => {
    let sum = 0;
    let n = 0;

    for (const team of teams) {
      const side = world.sideFor(team);

      if (!side) {
        continue;
      }

      const state = stateAt(DOWNS[down]!, dist, field, 3, 0);

      for (let i = 0; i < 60; i++) {
        sum += world.factors.gains(
          state, call, side.among[0] ?? "", rng, { offence: team });
        n++;
      }
    }

    return n ? sum / n : 1;
  };
  const baseMean: Record<Call, number> = {
    run: poolMeanAt("run", neutral.down, neutral.dist, neutral.field),
    pass: poolMeanAt("pass", neutral.down, neutral.dist, neutral.field),
  };

  for (const call of ["run", "pass"] as Call[]) {
    for (let down = 0; down < 4; down++) {
      for (let dist = 0; dist < DIST_BANDS; dist++) {
        for (let field = 0; field < FIELD_BANDS; field++) {
          const here = poolMeanAt(call, down, dist, field);
          const base = baseMean[call] || 1;
          gainScale.push(clampByte(Math.min(255, (here / base) * 64)));
        }
      }
    }
  }

  tables.league.gainScale = asBytes(gainScale);

  const kick: number[] = [];

  for (let yard = 0; yard < 100; yard++) {
    kick.push(rateByte(world.kicking.kickSucceeds(Math.max(1, yard))));
  }

  tables.league.kickSucceeds = asBytes(kick);

  for (let band = 0; band < FIELD_BANDS; band++) {
    const drawn: number[] = [];

    for (let i = 0; i < 3000; i++) {
      drawn.push(world.rules.puntLands(FIELD_MID[band]!, rng));
    }

    tables.league.puntQuantiles[band] = asBytes(quantilesOf(
      drawn.map((landed) => landed - YARD_OFFSET)));
  }

  const turnover: number[] = [];

  for (const call of ["run", "pass"] as Call[]) {
    for (let down = 0; down < 4; down++) {
      for (let field = 0; field < FIELD_BANDS; field++) {
        turnover.push(clampByte(world.rules.turnoverRate(call) * 2550));
      }
    }
  }

  tables.league.turnover = asBytes(turnover);

  const seconds: number[] = [];
  const GAIN_MID = [-3, 0, 3, 8, 20];

  for (const call of ["run", "pass"] as Call[]) {
    for (const gained of GAIN_MID) {
      for (let margin = 0; margin < MARGIN_BANDS; margin++) {
        for (let time = 0; time < TIME_BANDS; time++) {
          seconds.push(clampByte(world.ticking.secondsFor(
            call, gained, MARGIN_MID[margin]!, TIME_MID[time]!)));
        }
      }
    }
  }

  tables.league.secondsFor = asBytes(seconds);

  const fourth: number[] = [];

  for (let yard = 1; yard <= 99; yard++) {
    for (let dist = 0; dist < DIST_BANDS; dist++) {
      for (let margin = 0; margin < MARGIN_BANDS; margin++) {
        for (let time = 0; time < TIME_BANDS; time++) {
          const odds = world.fourth.chances({
            down: 4, toGo: Math.min(DIST_MID[dist]!, yard), yardline: yard,
            margin: MARGIN_MID[margin]!, secondsLeft: TIME_MID[time]!,
          });
          fourth.push(rateByte(odds.go), rateByte(odds.kick));
        }
      }
    }
  }

  tables.league.fourth = asBytes(fourth);

  const twos: number[] = [];

  for (let margin = -25; margin <= 25; margin++) {
    twos.push(rateByte(DEFAULT_AFTER_TOUCHDOWN.goesForTwo(margin, 1200)));
    twos.push(rateByte(DEFAULT_AFTER_TOUCHDOWN.goesForTwo(margin, 60)));
  }

  tables.league.goesForTwo = asBytes(twos);
  tables.league.twoPointRate = DEFAULT_AFTER_TOUCHDOWN.convertRate;
  tables.league.extraPointRate = DEFAULT_AFTER_TOUCHDOWN.extraPointRate;
  tables.league.rules = {
    penaltyFirstDown: world.rules.penaltyFirstDown,
    offenceFlag: world.rules.offenceFlag ?? 0,
    defenceFlag: world.rules.defenceFlag ?? 0,
    maxPlays: world.rules.maxPlays,
    isLast: world.kicking.isLast,
  };

  const penalty: number[] = [];

  for (let i = 0; i < 2000; i++) {
    penalty.push(world.rules.penaltyYards(rng));
  }

  tables.league.penaltyQuantiles = asBytes(quantilesOf(
    penalty.map((yards) => yards - YARD_OFFSET)));

  if (world.factors.matchup) {
    for (const offence of everyTeam) {
      const row: number[] = [];

      for (const defence of everyTeam) {
        for (const call of ["run", "pass"] as Call[]) {
          row.push(clampByte(
            world.factors.matchup(offence, defence, call) * 128));
        }
      }

      tables.league.matchup[offence] = asBytes(row);
    }
  }

  tables.league.teamOrder = everyTeam;

  const tablesForTeam = (
    from: Awaited<ReturnType<typeof buildWorld>>, team: string,
  ) => {
    const side = from.sideFor(team);

    if (!side) {
      return null;
    }

    const men = side.among.filter((id, at) => side.among.indexOf(id) === at);
    const runRate: number[] = [];

    for (let down = 0; down < 4; down++) {
      for (let dist = 0; dist < DIST_BANDS; dist++) {
        for (let field = 0; field < FIELD_BANDS; field++) {
          for (let margin = 0; margin < MARGIN_BANDS; margin++) {
            for (let time = 0; time < TIME_BANDS; time++) {
              const state = stateAt(DOWNS[down]!, dist, field, margin, time);
              runRate.push(rateByte(
                side.factors.runs(state, team, { offence: team })));
            }
          }
        }
      }
    }

    const shares: number[] = [];

    for (const call of ["run", "pass"] as Call[]) {
      for (const down of [1, 3]) {
        for (let field = 0; field < FIELD_BANDS; field++) {
          const state = stateAt(down, down === 1 ? 2 : 1, field, 3, 0);
          const split = side.factors.goesTo(state, call, men, { offence: team });
          const total = men.reduce((sum, id) => sum + (split.get(id) ?? 0), 0);

          for (const id of men) {
            shares.push(clampByte(((split.get(id) ?? 0) / (total || 1)) * 255));
          }
        }
      }
    }

    const gains: Record<string, string> = {};
    const caught: number[] = [];
    const sampleAt = stateAt(
      DOWNS[neutral.down]!, neutral.dist, neutral.field, neutral.margin,
      neutral.time);

    for (const id of men) {
      for (const call of ["run", "pass"] as Call[]) {
        const drawn: number[] = [];
        let completions = 0;

        for (let i = 0; i < SAMPLES; i++) {
          const own = side.factors.hisOwnPlay
            ? side.factors.hisOwnPlay(sampleAt, call, id, rng, side.passer,
                { offence: team, passer: side.passer })
            : undefined;
          const yards = own
            ? own.yards
            : Math.round(
                side.factors.gains(sampleAt, call, id, rng, { offence: team }));
          const held = call === "run" ||
            (own ? own.caught : side.factors.caught(yards, rng));

          if (held) {
            completions++;
            drawn.push(yards);
          }
        }

        gains[`${id}|${call}`] = asBytes(quantilesOf(drawn));
        caught.push(rateByte(completions / SAMPLES));
      }
    }

    return {
      passer: side.passer ?? "",
      men: men.map((id) => ({
        id,
        key: normalizeName(nameOf.get(id) ?? id),
        position: positionOf.get(id) ?? "",
      })),
      runRate: asBytes(runRate),
      shares: asBytes(shares),
      caught: asBytes(caught),
      gains,
    };
  };

  for (const team of teams) {
    const built = tablesForTeam(world, team);

    if (built) {
      tables.teams[team] = built;
    }
  }

  /**
   * A side on its bye has no roster that week, so `buildWorld` never
   * sees it and the live page would have nothing to play its next game
   * with. It is built from the nearest week it did play instead.
   */
  for (const week of nearestWeeks(WEEK)) {
    const short = everyTeam.filter((team) => !tables.teams[team]);

    if (!short.length) {
      break;
    }

    if (!short.some((team) => playedIn(week).has(team))) {
      continue;
    }

    console.log(`week ${week} fills in ${short.join(", ")}`);
    const fallback = await buildWorld(
      SEASON, week, true, positions, { componentShares: true });

    for (const team of short) {
      const built = tablesForTeam(fallback, team);

      if (built) {
        tables.teams[team] = built;
      }
    }
  }

  const out = join("docs", "data", `sim-${SEASON}.json`);
  await mkdir(join("docs", "data"), { recursive: true });
  const text = JSON.stringify(tables);
  await writeFile(out, text);
  console.log(`${out}: ${(text.length / 1024).toFixed(1)} KB, ` +
    `${Object.keys(tables.teams).length} teams`);
}

void main();

/**
 * A coordinator has a way he likes to line up, and he changes it for
 * who he is playing. The first part is his, and it measured strongly.
 * This is the second: how much a defence pulls an offence away from
 * what it usually does.
 *
 * Fitted the same way as pressure, since every offence meets many
 * defences and the schedule separates the two sides.
 *
 * Run: npx tsx scripts/schemeMatchupEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { loadCoaches } from "../src/data/coaches.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASONS = [2022, 2023, 2024, 2025];

function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else cell += ch;
  }

  cells.push(cell);
  return cells;
}

interface Meeting {
  offense: string;
  defense: string;
  plays: number;
  heavy: number;
  shotgun: number;
}

async function meetingsOf(season: number): Promise<Meeting[]> {
  const path = join(RAW_DIR, `participation_${season}.csv`);

  if (!existsSync(path)) {
    return [];
  }

  const tallies = new Map<string, Meeting>();
  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  let iTeam = -1, iPersonnel = -1, iFormation = -1, iGame = -1;

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      iTeam = header.indexOf("possession_team");
      iPersonnel = header.indexOf("offense_personnel");
      iFormation = header.indexOf("offense_formation");
      iGame = header.indexOf("nflverse_game_id");
      continue;
    }

    const cells = splitLine(line);
    const offense = cells[iTeam] ?? "";
    const personnel = cells[iPersonnel] ?? "";
    const parts = (cells[iGame] ?? "").split("_");

    if (!offense || !personnel || personnel === "NA" || parts.length < 4) {
      continue;
    }

    const defense = parts[2] === offense ? parts[3]! : parts[2]!;
    const backs = Number(/(\d+) RB/.exec(personnel)?.[1] ?? NaN);
    const tightEnds = Number(/(\d+) TE/.exec(personnel)?.[1] ?? NaN);

    if (!Number.isFinite(backs) || !Number.isFinite(tightEnds)) {
      continue;
    }

    const key = `${parts[1]}|${offense}|${defense}`;
    const meeting = tallies.get(key) ??
      { offense, defense, plays: 0, heavy: 0, shotgun: 0 };
    meeting.plays++;
    if (backs + tightEnds >= 3) meeting.heavy++;
    if (cells[iFormation] === "SHOTGUN") meeting.shotgun++;
    tallies.set(key, meeting);
  }

  return [...tallies.values()].filter((m) => m.plays >= 25);
}

/**
 * Alternating least squares, the same shape as the pressure fit: each
 * side's number is whatever makes its games add up once the other
 * side's is taken as read.
 */
function fitSides(meetings: Meeting[], rate: (m: Meeting) => number, rounds = 60) {
  const offense = new Map<string, number>();
  const defense = new Map<string, number>();
  const league =
    meetings.reduce((a, m) => a + rate(m) * m.plays, 0) /
    meetings.reduce((a, m) => a + m.plays, 0);

  for (const m of meetings) {
    offense.set(m.offense, 0);
    defense.set(m.defense, 0);
  }

  const solve = (
    target: Map<string, number>, other: Map<string, number>,
    keyOf: (m: Meeting) => string, otherOf: (m: Meeting) => string,
  ) => {
    const sum = new Map<string, number>();
    const weight = new Map<string, number>();

    for (const m of meetings) {
      const key = keyOf(m);
      const residual = rate(m) - league - (other.get(otherOf(m)) ?? 0);
      sum.set(key, (sum.get(key) ?? 0) + residual * m.plays);
      weight.set(key, (weight.get(key) ?? 0) + m.plays);
    }

    for (const [key, total] of sum) {
      target.set(key, total / ((weight.get(key) ?? 1) + 200));
    }
  };

  for (let round = 0; round < rounds; round++) {
    solve(offense, defense, (m) => m.offense, (m) => m.defense);
    solve(defense, offense, (m) => m.defense, (m) => m.offense);
  }

  return { offense, defense, league };
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const bySeason = new Map<number, Meeting[]>();

  for (const season of SEASONS) {
    bySeason.set(season, await meetingsOf(season));
    console.log(`${season}: ${bySeason.get(season)!.length} meetings`);
  }

  for (const [label, rate] of [
    ["heavy personnel", (m: Meeting) => m.heavy / m.plays],
    ["shotgun", (m: Meeting) => m.shotgun / m.plays],
  ] as [string, (m: Meeting) => number][]) {
    const fits = new Map(
      SEASONS.map((s) => [s, fitSides(bySeason.get(s) ?? [], rate)]),
    );

    console.log(`\n${label}\n`);
    const spread = (m: Map<string, number>) => {
      const values = [...m.values()].sort((a, b) => a - b);
      return (values[0]! * 100).toFixed(1) + " to " + (values.at(-1)! * 100).toFixed(1) + " points";
    };

    console.log("  how far each side moves it, 2025");
    console.log("    the offence  " + spread(fits.get(2025)!.offense));
    console.log("    the defence  " + spread(fits.get(2025)!.defense));

    // does the pull a defence exerts come back next season?
    const carry = (get: (f: ReturnType<typeof fitSides>) => Map<string, number>,
                   role: "OC" | "DC" | null) => {
      const before: number[] = [], after: number[] = [];

      for (const season of SEASONS.slice(1)) {
        const previous = fits.get(season - 1);
        const now = fits.get(season);
        if (!previous || !now) continue;

        for (const [team, value] of get(now)) {
          const was = get(previous).get(team);
          if (was === undefined) continue;

          if (role) {
            const kept = coaches.get(`${team}|${season}|${role}`) ===
              coaches.get(`${team}|${season - 1}|${role}`);
            if (!kept) continue;
          }

          before.push(was);
          after.push(value);
        }
      }

      return before.length >= 15 ? spearman(before, after).toFixed(3) : "too few";
    };

    console.log("  year over year");
    console.log("    the offence's own habit        " + carry((f) => f.offense, null));
    console.log("    the defence's pull             " + carry((f) => f.defense, null));
    // no defensive coordinators in coaches.csv, so splitting the
    // defence's pull by whether its play-caller stayed cannot be done
    console.log("    (no DC data, so that split is not available)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

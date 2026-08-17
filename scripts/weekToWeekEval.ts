/**
 * Which of a man's own weeks will be the good one.
 *
 * Across players this has always looked fine, because a good player
 * beats a bad one every week. Within one player it has been close to
 * nothing: .047 knowing the opponent, the line, the total and the wind.
 *
 * Two things are new. A team-mate who is out has his share shared among
 * whoever is left, which the walk now does by itself, and the defence
 * bends his yards. Only weeks he actually played are counted.
 *
 * Run: npx tsx scripts/weekToWeekEval.ts
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { splitLine } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { loadPlayerStats, RAW_DIR } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { buildPlayerVectors, ATTRIBUTES } from "../src/features/playerVector.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { againstDefence, NOBODY, type Against } from "../src/features/defenceStrength.js";
import { linesFrom, simulatePlayerDrive } from "../src/model/playerDrive.js";
import {
  INTERACTION_DEFAULTS, fitInteractionNet, type Described,
} from "../src/model/interactionNet.js";
import type { Draws } from "../src/model/playerWeek.js";
import type { SituationalRole } from "../src/model/situationalWeek.js";

const RULES = presets.standard;
const SCORE_ON = 2025;
const LEARN_FROM = [2022, 2023, 2024];
const DRIVES_A_GAME = 11;
const RUNS = 120;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const stateOf = (down: number, toGo: number, yardline: number, run: boolean) =>
  Float64Array.from([
    down === 1 ? 1 : 0, down === 2 ? 1 : 0, down === 3 ? 1 : 0, down === 4 ? 1 : 0,
    Math.min(toGo, 25) / 10, yardline / 100, yardline <= 10 ? 1 : 0, 0,
    run ? 1 : 0,
  ]);

/** who was on the field, described from the year before, and who played whom */
async function readSnaps() {
  const vectors = new Map<string, Float64Array>();

  for (const season of [...LEARN_FROM, SCORE_ON]) {
    for (const [id, player] of await buildPlayerVectors(season - 1)) {
      vectors.set(`${season}|${id}`, player.values);
    }
  }

  const averageOf = (ids: string[], season: number) => {
    const out = new Float64Array(ATTRIBUTES.length);
    let known = 0;

    for (const id of ids) {
      const player = vectors.get(`${season}|${id}`);
      if (!player) continue;
      known++;
      for (let i = 0; i < out.length; i++) out[i] = out[i]! + player[i]!;
    }

    if (known > 1) {
      for (let i = 0; i < out.length; i++) out[i] = out[i]! / known;
    }

    return out;
  };

  const learn: { on: Described[]; yards: number }[] = [];
  const defenceOf = new Map<string, Float64Array[]>();
  const faced = new Map<string, string>();
  const reader = createInterface({
    input: createReadStream(join(RAW_DIR, "onField.csv")),
  });
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      header.forEach((name, i) => { at[name] = i; });
      continue;
    }

    const c = splitLine(line);
    const season = Number(c[at["season"]!]);
    const ids = (text: string) => text.split(";").filter(Boolean);
    const offence = averageOf(ids(c[at["offenceOn"]!] ?? ""), season);
    const defence = averageOf(ids(c[at["defenceOn"]!] ?? ""), season);

    if (LEARN_FROM.includes(season)) {
      learn.push({
        yards: Number(c[at["yards"]!]) || 0,
        on: [
          { kind: "offence", values: offence },
          { kind: "defence", values: defence },
          {
            kind: "situation",
            values: stateOf(
              Number(c[at["down"]!]), Number(c[at["togo"]!]),
              Number(c[at["yardline"]!]), c[at["playType"]!] === "run",
            ),
          },
        ],
      });
    }

    if (season === SCORE_ON) {
      const team = c[at["defense"]!] ?? "";
      defenceOf.set(team, [...(defenceOf.get(team) ?? []), defence]);
      faced.set(`${c[at["week"]!]}|${c[at["offense"]!]}`, team);
    }
  }

  return { learn, defenceOf, faced };
}

function poolOf(rows: Float64Array[]): Float64Array {
  const out = new Float64Array(ATTRIBUTES.length);

  for (const row of rows) {
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + row[i]!;
  }

  for (let i = 0; i < out.length; i++) out[i] = out[i]! / Math.max(1, rows.length);
  return out;
}

async function main(): Promise<void> {
  const { learn, defenceOf, faced } = await readSnaps();
  console.time("fitting the network");
  const net = fitInteractionNet(
    learn.map((s) => s.on),
    [{ name: "yards", of: (i: number) => learn[i]!.yards }],
    { ...INTERACTION_DEFAULTS, passes: 6 },
  );
  console.timeEnd("fitting the network");

  const averageOffence = poolOf(learn.map((s) => s.on[0]!.values));
  const averageDefence = poolOf(learn.map((s) => s.on[1]!.values));
  const against = new Map<string, Against>();

  for (const [team, rows] of defenceOf) {
    against.set(team, againstDefence(
      net, poolOf(rows), averageOffence, averageDefence,
      (run) => stateOf(1, 10, 60, run),
    ));
  }

  const positions = new Map<string, string>();
  const games = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    games.set(s.playerId, (games.get(s.playerId) ?? 0) + 1);
  }

  const { byTeam } = await fitRoles(SCORE_ON - 1, positions, games);
  const rules = await fitDriveRules(LEARN_FROM);

  const scored = new Map<string, number>();
  const outThere = new Set<string>();
  const teamThatWeek = new Map<string, string>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18) continue;
    scored.set(`${s.week}|${s.playerId}`, fantasyPoints(s.statLine, RULES));
    outThere.add(`${s.week}|${s.playerId}`);
    teamThatWeek.set(`${s.week}|${s.playerId}`, s.teamId);
  }

  const passerOf = (roster: SituationalRole[]) => {
    const quarterbacks = roster.filter((p) => p.position === "QB");
    return quarterbacks.length
      ? quarterbacks.reduce((best, p) =>
          p.targetShare.openField + p.carryShare.openField >
          best.targetShare.openField + best.carryShare.openField ? p : best,
        ).playerId
      : "";
  };

  const rng = seededRng(9);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };

  /**
   * One team's week. `knowing` decides whether the walk is told who is
   * missing and who they are playing, or given the roster as it stood
   * in the summer against nobody in particular.
   */
  const playWeek = (
    team: string, week: number, roster: SituationalRole[], knowing: boolean,
  ) => {
    const quarterback = passerOf(roster);
    const other = faced.get(`${week}|${team}`);
    const bend = knowing && other ? against.get(other) ?? NOBODY : NOBODY;
    const totals = new Map<string, number>();

    for (let run = 0; run < RUNS; run++) {
      const available = roster.map((p) =>
        knowing
          ? outThere.has(`${week}|${p.playerId}`)
          : draws.uniform() < p.availability);
      const drives = Array.from({ length: DRIVES_A_GAME }, () =>
        simulatePlayerDrive(
          Math.max(35, Math.min(99, Math.round(75 + draws.normal() * 13))),
          roster, available, rules, draws, bend,
        ));

      for (const line of linesFrom(drives, roster, available, quarterback)) {
        totals.set(
          line.playerId, (totals.get(line.playerId) ?? 0) + fantasyPoints(line, RULES),
        );
      }
    }

    return new Map([...totals].map(([id, sum]) => [id, sum / RUNS]));
  };

  const rows: {
    playerId: string; real: number; missing: number;
    knowing: number; blind: number;
  }[] = [];

  for (const [team, roster] of byTeam) {
    for (let week = 1; week <= 18; week++) {
      if (!faced.has(`${week}|${team}`)) {
        continue;
      }

      const knowing = playWeek(team, week, roster, true);
      const blind = playWeek(team, week, roster, false);

      for (const player of roster) {
        const key = `${week}|${player.playerId}`;
        const real = scored.get(key);

        // only weeks he was out there, so this is not a test of
        // spotting who was inactive
        if (real === undefined || teamThatWeek.get(key) !== team) {
          continue;
        }

        // how much of this team's usual work was missing that week,
        // so the weeks the mechanism should matter for can be picked out
        const missing = roster
          .filter((p) => !outThere.has(`${week}|${p.playerId}`))
          .reduce((a, p) =>
            a + p.targetShare.openField + p.carryShare.openField, 0);

        rows.push({
          playerId: player.playerId, real, missing,
          knowing: knowing.get(player.playerId) ?? 0,
          blind: blind.get(player.playerId) ?? 0,
        });
      }
    }
  }

  console.log(`\n${rows.length} player-weeks in ${SCORE_ON}`);
  const ways = [
    ["not knowing the week", (r: (typeof rows)[number]) => r.blind],
    ["knowing who is out and who they play", (r: (typeof rows)[number]) => r.knowing],
  ] as [string, (r: (typeof rows)[number]) => number][];

  console.log("\nacross players                          spearman   average miss");

  for (const [label, of] of ways) {
    console.log(
      "  " + label.padEnd(38) + spearman(rows.map(of), rows.map((r) => r.real))
        .toFixed(4).padStart(7) +
      rmse(rows.map(of), rows.map((r) => r.real)).toFixed(2).padStart(15),
    );
  }

  const byPlayer = new Map<string, (typeof rows)[number][]>();

  for (const row of rows) {
    byPlayer.set(row.playerId, [...(byPlayer.get(row.playerId) ?? []), row]);
  }

  const spreadOf = (values: number[]) => {
    const mid = middle(values);
    return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
  };

  /**
   * A man's weeks against his own average, on both sides. `only` picks
   * out a subset of his weeks, for asking where the mechanism bites.
   */
  const within = (
    of: (r: (typeof rows)[number]) => number,
    only: (r: (typeof rows)[number]) => boolean = () => true,
  ) => {
    const saidOff: number[] = [];
    const wasOff: number[] = [];
    let counted = 0;

    for (const weeks of byPlayer.values()) {
      if (weeks.length < 6) {
        continue;
      }

      counted++;
      const saidMean = middle(weeks.map(of));
      const wasMean = middle(weeks.map((w) => w.real));

      for (const week of weeks) {
        if (!only(week)) continue;
        saidOff.push(of(week) - saidMean);
        wasOff.push(week.real - wasMean);
      }
    }

    return {
      rank: spearman(saidOff, wasOff), counted,
      said: spreadOf(saidOff), was: spreadOf(wasOff), weeks: saidOff.length,
    };
  };

  console.log("\nwithin one player                      spearman   players");

  for (const [label, of] of ways) {
    const out = within(of);
    console.log(
      "  " + label.padEnd(38) + out.rank.toFixed(4).padStart(7) +
      String(out.counted).padStart(10),
    );
  }

  console.log("\nhow far a week moves from a man's own average");

  for (const [label, of] of ways) {
    const out = within(of);
    console.log(
      "  " + label.padEnd(38) + "we say " + out.said.toFixed(2) +
      ", it really moves " + out.was.toFixed(2),
    );
  }

  // the weeks the sharing is meant to matter for
  const gone = rows.map((r) => r.missing).sort((a, b) => b - a);
  const lots = gone[Math.floor(gone.length * 0.2)]!;
  const short = within((r) => r.knowing, (r) => r.missing >= lots);
  const full = within((r) => r.knowing, (r) => r.missing <= gone[gone.length - 1]! + 0.02);
  console.log(
    "\nwhen a fifth or more of the usual work is missing (" + short.weeks + " weeks): " +
      short.rank.toFixed(4) +
      "\nwhen almost nobody is missing (" + full.weeks + " weeks): " + full.rank.toFixed(4),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

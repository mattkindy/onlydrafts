/**
 * Does knowing who is tackling him change anything?
 *
 * The walk now has players making the plays, but the yards a man gains
 * take no notice of the eleven in front of him. The interaction network
 * is asked what this defence does to an average offence, and the answer
 * scales the yards. Pooling a defence's plays in with the offence's was
 * tried and made things slightly worse, so this is the multiplicative
 * version of the same idea.
 *
 * Defenders are described from the season before the one being scored.
 *
 * Run: npx tsx scripts/defenceEval.ts
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv, splitLine } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { loadGames, loadPlayerStats, RAW_DIR } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { buildPlayerVectors, ATTRIBUTES } from "../src/features/playerVector.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { fitDriveRules, fitTeamDriveRules } from "../src/features/driveRules.js";
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
const RUNS = 60;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const stateOf = (down: number, toGo: number, yardline: number, run: boolean) =>
  Float64Array.from([
    down === 1 ? 1 : 0, down === 2 ? 1 : 0, down === 3 ? 1 : 0, down === 4 ? 1 : 0,
    Math.min(toGo, 25) / 10, yardline / 100, yardline <= 10 ? 1 : 0, 0,
    run ? 1 : 0,
  ]);

interface Snap {
  season: number;
  week: number;
  offense: string;
  defense: string;
  yards: number;
  on: Described[];
}

async function loadSnaps(): Promise<Snap[]> {
  const vectors = new Map<string, Float64Array>();

  for (const season of [...LEARN_FROM, SCORE_ON]) {
    // described from the year before, so no season describes itself
    for (const [id, player] of await buildPlayerVectors(season - 1)) {
      vectors.set(`${season}|${id}`, player.values);
    }
  }

  const averageOf = (ids: string[], season: number) => {
    const out = new Float64Array(ATTRIBUTES.length);
    let known = 0;

    for (const id of ids) {
      const player = vectors.get(`${season}|${id}`);

      if (!player) {
        continue;
      }

      known++;
      for (let i = 0; i < out.length; i++) out[i] = out[i]! + player[i]!;
    }

    if (known > 1) {
      for (let i = 0; i < out.length; i++) out[i] = out[i]! / known;
    }

    return out;
  };

  const snaps: Snap[] = [];
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

    snaps.push({
      season, week: Number(c[at["week"]!]),
      offense: c[at["offense"]!] ?? "", defense: c[at["defense"]!] ?? "",
      yards: Number(c[at["yards"]!]) || 0,
      on: [
        { kind: "offence", values: averageOf(ids(c[at["offenceOn"]!] ?? ""), season) },
        { kind: "defence", values: averageOf(ids(c[at["defenceOn"]!] ?? ""), season) },
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

  return snaps;
}

/** the average of a kind of entity over a set of snaps */
function averageEntity(snaps: Snap[], kind: string): Float64Array {
  const out = new Float64Array(ATTRIBUTES.length);
  let count = 0;

  for (const snap of snaps) {
    const entity = snap.on.find((e) => e.kind === kind);

    if (!entity) {
      continue;
    }

    count++;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + entity.values[i]!;
  }

  for (let i = 0; i < out.length; i++) out[i] = out[i]! / Math.max(1, count);
  return out;
}

async function main(): Promise<void> {
  const snaps = await loadSnaps();
  const learn = snaps.filter((s) => LEARN_FROM.includes(s.season));
  console.log(`${snaps.length} snaps, ${learn.length} to learn the network from`);

  console.time("fitting the network");
  const net = fitInteractionNet(
    learn.map((s) => s.on),
    [{ name: "yards", of: (i: number) => learn[i]!.yards }],
    { ...INTERACTION_DEFAULTS, passes: 6 },
  );
  console.timeEnd("fitting the network");

  const averageOffence = averageEntity(learn, "offence");
  const averageDefence = averageEntity(learn, "defence");

  // one description per defence, from the men it had on the field
  const byDefence = new Map<string, Snap[]>();

  for (const snap of snaps) {
    if (snap.season !== SCORE_ON) {
      continue;
    }

    byDefence.set(snap.defense, [...(byDefence.get(snap.defense) ?? []), snap]);
  }

  const against = new Map<string, Against>();

  for (const [team, own] of byDefence) {
    against.set(team, againstDefence(
      net, averageEntity(own, "defence"), averageOffence, averageDefence,
      (run) => stateOf(1, 10, 60, run),
    ));
  }

  const spread = [...against.values()];
  console.log(
    `\ndefences run ${Math.min(...spread.map((a) => a.run)).toFixed(3)} to ` +
      `${Math.max(...spread.map((a) => a.run)).toFixed(3)} on the ground and ` +
      `${Math.min(...spread.map((a) => a.pass)).toFixed(3)} to ` +
      `${Math.max(...spread.map((a) => a.pass)).toFixed(3)} through the air`,
  );

  // who each team played, week by week
  const faced = new Map<string, string>();

  for (const snap of snaps) {
    if (snap.season === SCORE_ON) {
      faced.set(`${snap.week}|${snap.offense}`, snap.defense);
    }
  }

  const positions = new Map<string, string>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  const { byTeam } = await fitRoles(SCORE_ON - 1, positions, played);
  const rules = await fitDriveRules(LEARN_FROM);
  // A team's own past plays carry its scheme and its play calling,
  // which the roster's shares do not, so try them as the base the
  // players stretch rather than the league's.
  const teamRules = (await fitTeamDriveRules(LEARN_FROM)).byTeam;

  const passerOf = (roster: SituationalRole[]) => {
    const quarterbacks = roster.filter((p) => p.position === "QB");
    return quarterbacks.length
      ? quarterbacks.reduce((best, p) =>
          p.targetShare.openField + p.carryShare.openField >
          best.targetShare.openField + best.carryShare.openField ? p : best,
        ).playerId
      : "";
  };

  const actual = new Map<string, number[]>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18) continue;
    actual.set(s.playerId, [
      ...(actual.get(s.playerId) ?? []), fantasyPoints(s.statLine, RULES),
    ]);
  }

  const runOnce = (seed: number, withDefence: boolean) => {
    const rng = seededRng(seed);
    const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };
    const said = new Map<string, number[]>();
    const points: number[] = [];

    for (const [team, roster] of byTeam) {
      const quarterback = passerOf(roster);

      for (let run = 0; run < RUNS; run++) {
        const week = 1 + (run % 18);
        const other = faced.get(`${week}|${team}`);
        const shift = withDefence && other ? against.get(other) ?? NOBODY : NOBODY;
        const available = roster.map((p) => draws.uniform() < p.availability);
        const drives = Array.from({ length: DRIVES_A_GAME }, () =>
          simulatePlayerDrive(
            Math.max(35, Math.min(99, Math.round(75 + draws.normal() * 13))),
            roster, available, teamRules.get(team) ?? rules, draws, shift,
          ));
        points.push(drives.reduce((a, d) =>
          a + (d.ending === "touchdown" ? 7 : d.ending === "fieldGoal" ? 3 : 0), 0));

        for (const line of linesFrom(drives, roster, available, quarterback)) {
          said.set(line.playerId, [
            ...(said.get(line.playerId) ?? []), fantasyPoints(line, RULES),
          ]);
        }
      }
    }

    const rows: { real: number; guess: number }[] = [];

    for (const [playerId, weeks] of actual) {
      const guess = said.get(playerId);
      if (!guess || weeks.length < 8) continue;
      rows.push({ real: middle(weeks), guess: middle(guess) });
    }

    return { rows, points: middle(points) };
  };

  const seeds = [21, 22, 23, 24, 25];
  console.log(`\nplayers, over ${seeds.length} starts`);
  console.log("  model                   rmse                        rank");

  for (const [label, withDefence] of [
    ["nobody in front of him", false], ["against that defence", true],
  ] as [string, boolean][]) {
    const runs = seeds.map((seed) => runOnce(seed, withDefence));
    const show = (values: number[]) => {
      const mid = middle(values);
      const sd = Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
      return `${mid.toFixed(3)} give or take ${sd.toFixed(3)}`;
    };
    console.log(
      "  " + label.padEnd(24) +
      show(runs.map((r) => rmse(r.rows.map((x) => x.guess), r.rows.map((x) => x.real))))
        .padEnd(28) +
      show(runs.map((r) => spearman(r.rows.map((x) => x.guess), r.rows.map((x) => x.real)))),
    );
  }

  // and whether the defence helps pick out a game, which is where it
  // ought to show up most
  const realPoints = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON || Number(row["week"]) > 18) continue;
    const key = `${row["week"]}|${row["offense"]}`;
    realPoints.set(key, (realPoints.get(key) ?? 0) + Number(row["points"]));
  }

  const vegas = new Map<string, number>();

  for (const game of await loadGames()) {
    if (game.season !== SCORE_ON || game.week > 18) continue;
    const { totalLine: total, spreadLine: line } = game;
    if (total === undefined || line === undefined) continue;
    vegas.set(`${game.week}|${game.homeTeamId}`, total / 2 + line / 2);
    vegas.set(`${game.week}|${game.awayTeamId}`, total / 2 - line / 2);
  }

  const rng = seededRng(31);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };
  const games: {
    real: number; plain: number; withThem: number; onTeam: number; line: number;
  }[] = [];

  for (const [key, real] of realPoints) {
    const [week, team] = key.split("|");
    const roster = byTeam.get(team!);
    const line = vegas.get(key);

    if (!roster || line === undefined) {
      continue;
    }

    const other = faced.get(`${week}|${team}`);
    const shift = other ? against.get(other) ?? NOBODY : NOBODY;
    const scoreOne = (bend: Against, base = rules) => {
      let total = 0;

      for (let run = 0; run < 40; run++) {
        const available = roster.map((p) => draws.uniform() < p.availability);
        const drives = Array.from({ length: DRIVES_A_GAME }, () =>
          simulatePlayerDrive(
            Math.max(35, Math.min(99, Math.round(75 + draws.normal() * 13))),
            roster, available, base, draws, bend,
          ));
        total += drives.reduce((a, d) =>
          a + (d.ending === "touchdown" ? 7 : d.ending === "fieldGoal" ? 3 : 0), 0);
      }

      return total / 40;
    };

    games.push({
      real,
      plain: scoreOne(NOBODY),
      withThem: scoreOne(shift),
      onTeam: scoreOne(shift, teamRules.get(team!) ?? rules),
      line,
    });
  }

  console.log(`\npoints a team scores in a game, ${games.length} of them`);
  console.log("  model                   rmse     rank");
  const truth = games.map((g) => g.real);

  for (const [label, guess] of [
    ["the league average", games.map(() => middle(truth))],
    ["nobody in front of them", games.map((g) => g.plain)],
    ["against that defence", games.map((g) => g.withThem)],
    ["on the team's own plays", games.map((g) => g.onTeam)],
    ["the betting line", games.map((g) => g.line)],
  ] as [string, number[]][]) {
    console.log(
      "  " + label.padEnd(24) + rmse(guess, truth).toFixed(2).padStart(6) +
      spearman(guess, truth).toFixed(3).padStart(9),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

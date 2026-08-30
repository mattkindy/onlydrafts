/**
 * Which layer of a play is the walk getting wrong?
 *
 * A snap is three decisions: whether it is a run, who gets the ball,
 * and what he makes with it. The walk is scored end to end everywhere
 * else, so a week that comes out wrong says nothing about which of
 * the three did it. This asks each one against the plays that really
 * happened, next to what a plain answer would have managed.
 *
 * Run: npx tsx scripts/playLayerEval.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { buildWorld } from "../src/features/playedWorld.js";
import { seededRng } from "../src/sim/rng.js";

const SEASON = Number(process.argv[2] ?? 2024);

const positions = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}

const world = await buildWorld(SEASON, 1, false, positions);
const plays = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
)).filter((r) =>
  Number(r["season"]) === SEASON && ["run", "pass"].includes(r["playType"] ?? ""));

/** the men each side had, as the walk sees them */
const among = new Map<string, string[]>();

for (const team of new Set(plays.map((r) => r["offense"]!))) {
  const side = world.sideFor(team);

  if (side) {
    among.set(team, side.among);
  }
}

let calls = 0;
let callBrier = 0;
let flatBrier = 0;
let leagueRuns = 0;

for (const r of plays) {
  if (r["playType"] === "run") {
    leagueRuns++;
  }
}

const leagueRate = leagueRuns / Math.max(1, plays.length);

let targets = 0;
let targetSaid = 0;
let targetFlat = 0;
let onTop = 0;
let onTopFlat = 0;

/** how often each man took the ball for his side, over the season */
const tookIt = new Map<string, number>();
const sideTook = new Map<string, number>();

for (const r of plays) {
  if (!r["player"]) {
    continue;
  }

  tookIt.set(r["player"], (tookIt.get(r["player"]) ?? 0) + 1);
  sideTook.set(r["offense"]!, (sideTook.get(r["offense"]!) ?? 0) + 1);
}

let gains = 0;
let gainOff = 0;
let flatOff = 0;
const rng = seededRng(11);
const middleOf = new Map<string, { n: number; yards: number }>();

for (const r of plays) {
  const call = r["playType"] as "run" | "pass";
  const own = middleOf.get(call) ?? { n: 0, yards: 0 };
  own.n++;
  own.yards += Number(r["yards"]) || 0;
  middleOf.set(call, own);
}

for (const r of plays) {
  const state = {
    down: Number(r["down"]), toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
    secondsLeft: Number(r["seconds"]) || 1800,
  };

  if (!Number.isFinite(state.down) || !Number.isFinite(state.yardline)) {
    continue;
  }

  const wasRun = r["playType"] === "run" ? 1 : 0;
  const said = world.factors.runs(state, r["offense"], {
    offence: r["offense"], defence: r["defense"],
  });
  calls++;
  callBrier += (said - wasRun) ** 2;
  flatBrier += (leagueRate - wasRun) ** 2;

  const men = among.get(r["offense"]!);

  if (men && r["player"] && men.includes(r["player"])) {
    const shares = world.factors.goesTo(
      state, r["playType"] as "run" | "pass", men,
      { offence: r["offense"], defence: r["defense"] },
    );
    const his = shares.get(r["player"]) ?? 0;
    const flat = (tookIt.get(r["player"]) ?? 0) /
      Math.max(1, sideTook.get(r["offense"]!) ?? 1);
    targets++;
    targetSaid += his;
    targetFlat += flat;
    let best = "";
    let most = -1;

    for (const [who, share] of shares) {
      if (share > most) {
        most = share;
        best = who;
      }
    }

    if (best === r["player"]) {
      onTop++;
    }

    let bestFlat = "";
    let mostFlat = -1;

    for (const who of men) {
      const share = (tookIt.get(who) ?? 0) /
        Math.max(1, sideTook.get(r["offense"]!) ?? 1);

      if (share > mostFlat) {
        mostFlat = share;
        bestFlat = who;
      }
    }

    if (bestFlat === r["player"]) {
      onTopFlat++;
    }
  }

  if (r["player"]) {
    // the mean of its draws, since a single draw carries the spread
    // the walk is meant to have and the average has none
    let sum = 0;
    const TRIES = 12;

    for (let i = 0; i < TRIES; i++) {
      sum += world.factors.gains(
        state, r["playType"] as "run" | "pass", r["player"], rng,
        { offence: r["offense"], defence: r["defense"], passer: r["passer"] },
      );
    }

    const drawn = sum / TRIES;
    const was = Number(r["yards"]) || 0;
    const flat = middleOf.get(r["playType"] as string);
    gains++;
    gainOff += Math.abs(drawn - was);
    flatOff += Math.abs((flat ? flat.yards / flat.n : 5) - was);
  }
}

console.log(`${SEASON}, over ${calls} plays that really happened:`);
console.log(
  `  the call        walk misses by ${(callBrier / calls).toFixed(4)}, ` +
  `saying the league rate every time misses by ${(flatBrier / calls).toFixed(4)}`,
);
console.log(
  `  who gets it     walk gives the man who got it ` +
  `${(100 * targetSaid / targets).toFixed(1)}% of the play, ` +
  `his own season share gives him ${(100 * targetFlat / targets).toFixed(1)}%`,
);
console.log(
  `                  and names him first ${(100 * onTop / targets).toFixed(1)}% ` +
  `of the time against ${(100 * onTopFlat / targets).toFixed(1)}%`,
);
console.log(
  `  what he makes   walk is out by ${(gainOff / gains).toFixed(2)} yards a play, ` +
  `the call's average is out by ${(flatOff / gains).toFixed(2)}`,
);

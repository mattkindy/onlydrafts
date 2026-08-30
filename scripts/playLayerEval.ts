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
import { spearman } from "../src/backtest/metrics.js";

const SEASON = Number(process.argv[2] ?? 2024);
/** enough touches that half of them still says something about him */
const ENOUGH_PLAYS = 60;

const positions = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}

const world = await buildWorld(SEASON, 1, false, positions);
const every = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
)).filter((r) => ["run", "pass"].includes(r["playType"] ?? ""));
const plays = every.filter((r) => Number(r["season"]) === SEASON);

/**
 * Last season's share of each call, which is the rival the walk has
 * to beat. The two below that read this season know how it went and
 * are there to say what was there to be had, not to be beaten.
 */
const tookBefore = new Map<string, number>();
const sideBefore = new Map<string, number>();

for (const r of every) {
  if (Number(r["season"]) !== SEASON - 1 || !r["player"]) {
    continue;
  }

  const key = `${r["player"]}|${r["playType"]}`;
  tookBefore.set(key, (tookBefore.get(key) ?? 0) + 1);
  const side = `${r["offense"]}|${r["playType"]}`;
  sideBefore.set(side, (sideBefore.get(side) ?? 0) + 1);
}

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
let onTopCall = 0;
let targetCall = 0;
let onTopBefore = 0;
let targetBefore = 0;
let sawBefore = 0;
const nearGoal = new Map<string, {
  plays: number; onTop: number; said: number; onTopBefore: number;
}>();

/** how often each man took the ball for his side, over the season */
const tookIt = new Map<string, number>();
const sideTook = new Map<string, number>();
/**
 * And the same split by whether it was run or thrown, which is most
 * of what tells a back from a receiver. Both are counted on the very
 * season they are scored against, so they know what happened and the
 * walk does not. They are here as a ceiling, not as a fair rival.
 */
const tookOn = new Map<string, number>();
const sideOn = new Map<string, number>();

for (const r of plays) {
  if (!r["player"]) {
    continue;
  }

  tookIt.set(r["player"], (tookIt.get(r["player"]) ?? 0) + 1);
  sideTook.set(r["offense"]!, (sideTook.get(r["offense"]!) ?? 0) + 1);
  const call = r["playType"]!;
  tookOn.set(`${r["player"]}|${call}`, (tookOn.get(`${r["player"]}|${call}`) ?? 0) + 1);
  sideOn.set(`${r["offense"]}|${call}`, (sideOn.get(`${r["offense"]}|${call}`) ?? 0) + 1);
}

let gains = 0;
let gainOff = 0;
let flatOff = 0;

/**
 * Each man's plays, with what the walk expected of them and what they
 * made, and the actual yards split odd play from even. A man's own
 * average over a season is mostly noise, so the two halves are what
 * says how much of the spread between men is a thing about the men.
 */
const eachMan = new Map<string, {
  n: number; said: number; was: number; runs: number;
  odd: number; oddN: number; even: number; evenN: number;
}>();
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

    /**
     * And the same inside the ten, where the touchdowns are. A back
     * who gets the ball on the goal line is worth six points for it,
     * and the walk hands those out on his share of everything.
     */
    if (state.yardline <= 10) {
      const near = nearGoal.get(r["playType"]!) ??
        { plays: 0, onTop: 0, said: 0, onTopBefore: 0 };
      near.plays++;
      near.said += his;

      if (best === r["player"]) {
        near.onTop++;
      }

      let bestNear = "";
      let mostNear = -1;

      for (const who of men) {
        const had = tookBefore.get(`${who}|${r["playType"]}`) ?? 0;

        if (had > mostNear) {
          mostNear = had;
          bestNear = who;
        }
      }

      if (bestNear === r["player"]) {
        near.onTopBefore++;
      }

      nearGoal.set(r["playType"]!, near);
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

    const call = r["playType"]!;
    const onCall = (who: string) => (tookOn.get(`${who}|${call}`) ?? 0) /
      Math.max(1, sideOn.get(`${r["offense"]}|${call}`) ?? 1);
    let bestCall = "";
    let mostCall = -1;

    for (const who of men) {
      if (onCall(who) > mostCall) {
        mostCall = onCall(who);
        bestCall = who;
      }
    }

    targetCall += onCall(r["player"]);

    if (bestCall === r["player"]) {
      onTopCall++;
    }

    // and the same off last season, which is what the walk knows too
    let allBefore = 0;

    for (const who of men) {
      allBefore += tookBefore.get(`${who}|${call}`) ?? 0;
    }

    let bestBefore = "";
    let mostBefore = -1;

    for (const who of men) {
      const had = tookBefore.get(`${who}|${call}`) ?? 0;

      if (had > mostBefore) {
        mostBefore = had;
        bestBefore = who;
      }
    }

    if (allBefore > 0) {
      sawBefore++;
      targetBefore +=
        (tookBefore.get(`${r["player"]}|${call}`) ?? 0) / allBefore;

      if (bestBefore === r["player"]) {
        onTopBefore++;
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

    const own = eachMan.get(r["player"]) ?? {
      n: 0, said: 0, was: 0, odd: 0, oddN: 0, even: 0, evenN: 0, runs: 0,
    };
    own.n++;
    own.said += drawn;
    own.was += was;

    if (own.n % 2 === 1) {
      own.odd += was;
      own.oddN++;
    } else {
      own.even += was;
      own.evenN++;
    }

    own.runs += r["playType"] === "run" ? 1 : 0;
    eachMan.set(r["player"], own);
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
  `                  and puts him top of the list ` +
  `${(100 * onTop / targets).toFixed(1)}% of the time against ` +
  `${(100 * onTopFlat / targets).toFixed(1)}%`,
);
console.log(
  `                  last season's share of the call: ` +
  `${(100 * targetBefore / Math.max(1, sawBefore)).toFixed(1)}% of the play, ` +
  `top of the list ${(100 * onTopBefore / Math.max(1, sawBefore)).toFixed(1)}%`,
);
console.log(
  `                  and knowing this season and the call, which is the ` +
  `most anyone could do: ${(100 * targetCall / targets).toFixed(1)}% of the ` +
  `play, top of the list ${(100 * onTopCall / targets).toFixed(1)}%`,
);

for (const [call, near] of nearGoal) {
  console.log(
    `  inside the ten  ${call.padEnd(5)} ${String(near.plays).padStart(5)} plays  ` +
    `walk gives him ${(100 * near.said / near.plays).toFixed(1)}% and puts him ` +
    `top ${(100 * near.onTop / near.plays).toFixed(1)}%, ` +
    `last season's counts ${(100 * near.onTopBefore / near.plays).toFixed(1)}%`,
  );
}
console.log(
  `  what he makes   walk is out by ${(gainOff / gains).toFixed(2)} yards a play, ` +
  `the call's average is out by ${(flatOff / gains).toFixed(2)}`,
);

/**
 * Does it tell one man from another, and by enough?
 *
 * Half the point of playing a season out is that a good back gains
 * more than a poor one in the same place. If the walk's men are all
 * near the league average, it is a situation model wearing a roster.
 */
const spread = (of: number[]) => {
  const mid = of.reduce((a, b) => a + b, 0) / Math.max(1, of.length);

  return Math.sqrt(
    of.reduce((sum, v) => sum + (v - mid) ** 2, 0) / Math.max(1, of.length),
  );
};
const enough = [...eachMan.values()].filter((m) => m.n >= ENOUGH_PLAYS &&
  m.oddN > 0 && m.evenN > 0);

console.log(`\na yard a touch, over men with ${ENOUGH_PLAYS} touches or more:`);

/**
 * Split by what they are given, since a run is drawn from a pool of
 * runs and a throw from a pool at the man's own depth. Only the throw
 * has the depth already in the draw, so only the throw can have it
 * counted a second time by his level on top.
 */
for (const [who, mine] of [
  ["they mostly run", enough.filter((m) => m.runs / m.n > 0.7)],
  ["they mostly catch", enough.filter((m) => m.runs / m.n < 0.3)],
  ["everyone", enough],
] as [string, typeof enough][]) {
  if (mine.length < 20) {
    continue;
  }

  const said = mine.map((m) => m.said / m.n);
  const was = mine.map((m) => m.was / m.n);
  const odd = mine.map((m) => m.odd / m.oddN);
  const even = mine.map((m) => m.even / m.evenN);
  const midOf = (of: number[]) =>
    of.reduce((a, b) => a + b, 0) / Math.max(1, of.length);
  const midOdd = midOf(odd);
  const midEven = midOf(even);
  const midSaid = midOf(said);
  /**
   * The two halves of a man's own season agree only on what is really
   * his, so how far they move together is the spread worth having.
   * The spread of his whole season has a season of luck in it too.
   */
  const truly = Math.sqrt(Math.max(0, odd.reduce(
    (sum, v, i) => sum + (v - midOdd) * (even[i]! - midEven), 0,
  ) / Math.max(1, odd.length)));
  // and above one here means the walk is speaking too quietly
  const slope = (odd.reduce(
    (sum, v, i) => sum + (said[i]! - midSaid) * (v - midOdd), 0,
  ) / Math.max(1, odd.length)) / Math.max(1e-9, spread(said) ** 2);

  console.log(
    `  ${who.padEnd(18)}${String(mine.length).padStart(4)} men  ` +
    `walk spreads ${spread(said).toFixed(2)}, ` +
    `${truly.toFixed(2)} of theirs is real, ` +
    `orders ${spearman(said, was).toFixed(3)}, ` +
    `wants ${slope.toFixed(2)}x`,
  );
}

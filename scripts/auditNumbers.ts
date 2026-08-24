/**
 * The claims from the last few hours, worked out again more carefully.
 *
 * One of them was already wrong because a week was counted inside its
 * own baseline. This re-derives each headline number with the week or
 * the season left out of whatever it is measured against, reports how
 * much of the answer is sampling noise, and works a per player average
 * beside the pooled one, since pooling lets a man with many weeks speak
 * louder than a man with few.
 *
 * Run: npx tsx scripts/auditNumbers.ts
 */

import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/** roughly how much a rank correlation moves by chance on this many pairs */
const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

const show = (rank: number, n: number) =>
  `${rank.toFixed(3)} give or take ${noise(n).toFixed(3)} (${n})`;

/** the average of per player correlations, through Fisher's transform */
function averaged(perPlayer: number[]): number {
  const usable = perPlayer.filter((r) => Number.isFinite(r) && Math.abs(r) < 0.999);

  if (!usable.length) {
    return 0;
  }

  const z = middle(usable.map((r) => 0.5 * Math.log((1 + r) / (1 - r))));
  return (Math.exp(2 * z) - 1) / (Math.exp(2 * z) + 1);
}

interface Week {
  week: number;
  points: number;
  touches: number;
}

async function main(): Promise<void> {
  const byPlayer = new Map<string, Week[]>();

  for (const s of await loadPlayerStats(2025)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    byPlayer.set(s.playerId, [...(byPlayer.get(s.playerId) ?? []), {
      week: s.week,
      points: fantasyPoints(s.statLine, RULES),
      touches: s.carries + s.targets,
    }]);
  }

  const players = [...byPlayer.values()]
    .filter((w) => w.length >= 8 && middle(w.map((x) => x.touches)) >= 3)
    .map((w) => [...w].sort((a, b) => a.week - b.week));
  console.log(`${players.length} men, ${players.reduce((a, w) => a + w.length, 0)} weeks\n`);

  /**
   * A man's weeks against his own average, with the week in question
   * left out of that average on both sides, and out of any rate the
   * guess is built from.
   */
  const withinPlayer = (
    say: (week: Week, others: Week[]) => number,
  ) => {
    const pooledSaid: number[] = [];
    const pooledWas: number[] = [];
    const each: number[] = [];

    for (const own of players) {
      const said: number[] = [];
      const was: number[] = [];

      for (let i = 0; i < own.length; i++) {
        const others = own.filter((_, j) => j !== i);
        const guess = say(own[i]!, others);

        if (!Number.isFinite(guess)) {
          continue;
        }

        said.push(guess);
        was.push(own[i]!.points);
      }

      if (said.length < 4) {
        continue;
      }

      const saidMid = middle(said);
      const wasMid = middle(was);

      for (let i = 0; i < said.length; i++) {
        pooledSaid.push(said[i]! - saidMid);
        pooledWas.push(was[i]! - wasMid);
      }

      each.push(spearman(said, was));
    }

    return {
      pooled: spearman(pooledSaid, pooledWas),
      perPlayer: averaged(each),
      n: pooledSaid.length,
      men: each.length,
    };
  };

  console.log("within one player, his own weeks");

  // No points per touch anywhere in here. Within one man, multiplying
  // every week of his by the same number leaves his order alone, so a
  // rate cannot change the answer. Working one out from his other weeks
  // does change it, and wrongly: a week that scored well drags the
  // others' average down, so the rate it is multiplied by comes out
  // low, which is a correlation built by the arithmetic.
  const claims: [string, (week: Week, others: Week[]) => number][] = [
    ["knowing his touches", (week) => week.touches],
    ["guessing touches from his last one", (week, others) => {
      const before = others.filter((w) => w.week < week.week).slice(-1);
      return before.length ? before[0]!.touches : NaN;
    }],
    ["guessing touches from his last three", (week, others) => {
      const before = others.filter((w) => w.week < week.week).slice(-3);
      return before.length === 3 ? middle(before.map((w) => w.touches)) : NaN;
    }],
    ["guessing touches from every week before", (week, others) => {
      const before = others.filter((w) => w.week < week.week);
      return before.length >= 3 ? middle(before.map((w) => w.touches)) : NaN;
    }],
  ];

  for (const [label, say] of claims) {
    const out = withinPlayer(say);
    console.log(
      "  " + label.padEnd(38) + "pooled " + show(out.pooled, out.n) +
      `   per man ${out.perPlayer.toFixed(3)} over ${out.men}`,
    );
  }

  // the workload on its own, which is the link the points hang off
  const pooledSaid: number[] = [];
  const pooledWas: number[] = [];

  for (const own of players) {
    for (let i = 0; i < own.length; i++) {
      const others = own.filter((_, j) => j !== i);
      const before = others.filter((w) => w.week < own[i]!.week).slice(-3);

      if (before.length < 3) {
        continue;
      }

      const mid = middle(others.map((w) => w.touches));
      pooledSaid.push(middle(before.map((w) => w.touches)) - mid);
      pooledWas.push(own[i]!.touches - mid);
    }
  }

  console.log(
    "\n  guessing his touches from his last three  " +
      show(spearman(pooledSaid, pooledWas), pooledSaid.length),
  );

  /**
   * The three links on one set of weeks, so the arithmetic can be
   * checked. If recent work predicts this week's work, and this week's
   * work predicts the points, then recent work should predict the
   * points, and it does not. Something has to be pulling the other way.
   */
  const link: Record<string, { said: number[]; was: number[] }> = {
    "recent work to this week's work": { said: [], was: [] },
    "this week's work to the points": { said: [], was: [] },
    "recent work to the points": { said: [], was: [] },
    "recent work to what he made per touch": { said: [], was: [] },
  };

  for (const own of players) {
    for (let i = 0; i < own.length; i++) {
      const others = own.filter((_, j) => j !== i);
      const before = others.filter((w) => w.week < own[i]!.week).slice(-3);

      if (before.length < 3 || own[i]!.touches < 1) {
        continue;
      }

      const recent = middle(before.map((w) => w.touches));
      const midTouch = middle(others.map((w) => w.touches));
      const midPoints = middle(others.map((w) => w.points));
      const perTouch = own[i]!.points / own[i]!.touches;
      const midPerTouch = middle(
        others.filter((w) => w.touches >= 1).map((w) => w.points / w.touches),
      );

      link["recent work to this week's work"]!.said.push(recent - midTouch);
      link["recent work to this week's work"]!.was.push(own[i]!.touches - midTouch);
      link["this week's work to the points"]!.said.push(own[i]!.touches - midTouch);
      link["this week's work to the points"]!.was.push(own[i]!.points - midPoints);
      link["recent work to the points"]!.said.push(recent - midTouch);
      link["recent work to the points"]!.was.push(own[i]!.points - midPoints);
      link["recent work to what he made per touch"]!.said.push(recent - midTouch);
      link["recent work to what he made per touch"]!.was.push(perTouch - midPerTouch);
    }
  }

  console.log("\nthe same weeks, link by link");

  for (const [label, pair] of Object.entries(link)) {
    console.log(
      "  " + label.padEnd(40) + show(spearman(pair.said, pair.was), pair.said.length),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

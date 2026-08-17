/**
 * How much of a man's week to week swing could anyone get.
 *
 * The walk moves a player 2.05 points from his own average where he
 * really moves 4.95, and what movement it has barely lines up with his.
 * Before trying to close that, it is worth knowing how much of the
 * swing is his workload, which somebody might see coming, and how much
 * is what happened once he had the ball, which nobody does.
 *
 * Each of these is given the answer to something and asked the rest,
 * so they are ceilings rather than predictions.
 *
 * Run: npx tsx scripts/weeklyCeilingEval.ts
 */

import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;
const SCORE_ON = 2025;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const spreadOf = (values: number[]) => {
  const mid = middle(values);
  return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
};

interface Week {
  week: number;
  points: number;
  touches: number;
  yards: number;
  scores: number;
}

async function main(): Promise<void> {
  const byPlayer = new Map<string, Week[]>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) {
      continue;
    }

    byPlayer.set(s.playerId, [...(byPlayer.get(s.playerId) ?? []), {
      week: s.week,
      points: fantasyPoints(s.statLine, RULES),
      // targets rather than catches, since what he was given is the
      // workload and what he caught is already an outcome
      touches: s.carries + s.targets,
      yards: s.statLine.rushYds + s.statLine.recYds,
      scores: s.statLine.rushTd + s.statLine.recTd,
    }]);
  }

  const players = [...byPlayer.values()]
    .filter((weeks) =>
      weeks.length >= 8 && middle(weeks.map((w) => w.touches)) >= 3)
    .map((weeks) => [...weeks].sort((a, b) => a.week - b.week));
  console.log(`${players.length} men with eight weeks or more in ${SCORE_ON}\n`);

  /**
   * Each guess is built from a man's own season rates and whatever this
   * particular row is allowed to know about the week.
   */
  const ways: [string, (week: Week, own: Week[]) => number][] = [
    ["his own average, every week", (_week, own) => middle(own.map((w) => w.points))],
    ["knowing how often he touched it", (week, own) => {
      const perTouch = middle(own.map((w) => w.points)) /
        Math.max(0.1, middle(own.map((w) => w.touches)));
      return week.touches * perTouch;
    }],
    ["knowing his yards", (week, own) => {
      const perYard = middle(own.map((w) => w.points)) /
        Math.max(0.1, middle(own.map((w) => w.yards)));
      return week.yards * perYard;
    }],
    ["knowing his yards and his scores", (week) => week.yards * 0.1 + week.scores * 6],
    // the same as knowing his touches, but guessing them from the
    // weeks before rather than being told, which is what anybody
    // setting a line-up actually has
    // Weeks with nothing to look back on are skipped rather than
    // handed the season average, which would both leak and pin their
    // deviation to nothing.
    ["guessing touches from his last three", (week, own) => {
      const perTouch = middle(own.map((w) => w.points)) /
        Math.max(0.1, middle(own.map((w) => w.touches)));
      const before = own.filter((w) => w.week < week.week).slice(-3);
      return before.length < 3 ? NaN : middle(before.map((w) => w.touches)) * perTouch;
    }],
    ["guessing touches from his last one", (week, own) => {
      const perTouch = middle(own.map((w) => w.points)) /
        Math.max(0.1, middle(own.map((w) => w.touches)));
      const before = own.filter((w) => w.week < week.week).slice(-1);
      return before.length < 1 ? NaN : before[0]!.touches * perTouch;
    }],
  ];

  console.log("within one player                          spearman   how far we move him");

  for (const [label, say] of ways) {
    const said: number[] = [];
    const was: number[] = [];

    for (const own of players) {
      const guesses = own.map((week) => say(week, own));
      const usable = own.map((_, i) => Number.isFinite(guesses[i]!));

      for (let i = 0; i < own.length; i++) {
        if (!usable[i]) {
          continue;
        }

        // his average with this week left out of it. Counting a week
        // inside its own baseline drags the answer down by about one
        // over the number of weeks, which on a ten game season turns a
        // small positive into a negative.
        const otherSaid = guesses.filter((_, j) => j !== i && usable[j]!);
        const otherWas = own
          .filter((_, j) => j !== i && usable[j]!).map((w) => w.points);
        said.push(guesses[i]! - middle(otherSaid));
        was.push(own[i]!.points - middle(otherWas));
      }
    }

    console.log(
      "  " + label.padEnd(40) + spearman(said, was).toFixed(4).padStart(8) +
      spreadOf(said).toFixed(2).padStart(14),
    );
  }

  // the same question asked of the workload itself, so the chain can
  // be seen: does the past predict his touches, and do his touches
  // predict his points
  console.log("\nthe workload on its own                    spearman");

  for (const [label, look] of [["from his last one", 1], ["from his last three", 3]] as
    [string, number][]) {
    const said: number[] = [];
    const was: number[] = [];

    for (const own of players) {
      for (let i = 0; i < own.length; i++) {
        const before = own.filter((w) => w.week < own[i]!.week).slice(-look);

        if (before.length < look) {
          continue;
        }

        const others = own.filter((_, j) => j !== i);
        const mid = middle(others.map((w) => w.touches));
        said.push(middle(before.map((w) => w.touches)) - mid);
        was.push(own[i]!.touches - mid);
      }
    }

    console.log(
      "  guessing his touches " + label.padEnd(20) +
      spearman(said, was).toFixed(4).padStart(8) + `   (${said.length} weeks)`,
    );
  }

  const swings: number[] = [];

  for (const own of players) {
    const mean = middle(own.map((w) => w.points));
    for (const week of own) swings.push(week.points - mean);
  }

  console.log(`\n  he really moves ${spreadOf(swings).toFixed(2)} from his own average`);

  // how much of the swing is the workload and how much is what came of
  // it, as a share of the variance
  const touchShare: number[] = [];
  const yardShare: number[] = [];

  for (const own of players) {
    const perTouch = middle(own.map((w) => w.points)) /
      Math.max(0.1, middle(own.map((w) => w.touches)));
    const perYard = middle(own.map((w) => w.points)) /
      Math.max(0.1, middle(own.map((w) => w.yards)));
    const mean = middle(own.map((w) => w.points));

    for (const week of own) {
      touchShare.push(week.touches * perTouch - mean);
      yardShare.push(week.yards * perYard - mean);
    }
  }

  const all = spreadOf(swings) ** 2;
  console.log(
    "  of that swing, touches explain " +
      (100 * (spreadOf(touchShare) ** 2) / all).toFixed(0) + "% and yards " +
      (100 * (spreadOf(yardShare) ** 2) / all).toFixed(0) + "%",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

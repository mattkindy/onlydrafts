/**
 * A coordinator's level, worked out from the changes he causes.
 *
 * Asking what a coordinator did at his last club said nothing about
 * the next, but that asked the wrong thing: a man arriving after a
 * run-first predecessor and the same man arriving after a thrower
 * should move the backs in opposite directions. An arrival shows the
 * difference between two coordinators, not the level of one.
 *
 * So give every coordinator a level, fit the lot to the changes at
 * once, then keep arrivals back and see whether the levels call them.
 *
 * Run: npx tsx scripts/coordinatorLevelEval.ts
 */

import { spearman, rmse } from "../src/backtest/metrics.js";
import { loadCoaches } from "../src/data/coaches.js";
import { loadRushingSeasons } from "../src/data/advancedStats.js";
import { asTeam } from "../src/features/runParts.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Arrival {
  team: string;
  season: number;
  arriving: string;
  leaving: string;
  /** how the backs who stayed moved, averaged over them */
  moved: { before: number; after: number; carry: number };
  backs: number;
}

/**
 * Levels that best explain the differences, with a penalty so a man
 * seen once does not take a wild one. Each arrival says the new man
 * less the old one came to this much, which pins the levels down only
 * up to a constant. The penalty settles that by pulling toward zero.
 */
function levelsFrom(
  arrivals: Arrival[], of: (one: Arrival) => number, penalty: number,
  passes = 300, rate = 0.05,
): Map<string, number> {
  const level = new Map<string, number>();

  for (const one of arrivals) {
    level.set(one.arriving, 0);
    level.set(one.leaving, 0);
  }

  for (let pass = 0; pass < passes; pass++) {
    const step = new Map<string, number>();

    for (const one of arrivals) {
      const said = (level.get(one.arriving) ?? 0) - (level.get(one.leaving) ?? 0);
      const off = of(one) - said;
      step.set(one.arriving, (step.get(one.arriving) ?? 0) + off);
      step.set(one.leaving, (step.get(one.leaving) ?? 0) - off);
    }

    for (const [who, was] of level) {
      level.set(who, was + rate * ((step.get(who) ?? 0) - penalty * was));
    }
  }

  return level;
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const seasons = await loadRushingSeasons(40);
  const byPlayer = new Map<string, Map<number, (typeof seasons)[number]>>();

  for (const row of seasons) {
    const own = byPlayer.get(row.pfrId) ?? new Map();
    own.set(row.season, row);
    byPlayer.set(row.pfrId, own);
  }

  const changes = new Map<string, {
    arriving: string; leaving: string; team: string; season: number;
    before: number[]; after: number[]; carry: number[];
  }>();

  for (const own of byPlayer.values()) {
    for (const [season, was] of own) {
      const now = own.get(season + 1);

      if (!now || asTeam(was.team) !== asTeam(now.team)) {
        continue;
      }

      const team = asTeam(now.team);
      const leaving = coaches.get(`${team}|${season}|OC`) ?? "";
      const arriving = coaches.get(`${team}|${season + 1}|OC`) ?? "";

      if (!leaving || !arriving || leaving === arriving) {
        continue;
      }

      const key = `${team}|${season + 1}`;
      const already = changes.get(key) ?? {
        arriving, leaving, team, season: season + 1,
        before: [], after: [], carry: [],
      };
      already.before.push(now.beforeContact - was.beforeContact);
      already.after.push(now.afterContact - was.afterContact);
      already.carry.push(now.perCarry - was.perCarry);
      changes.set(key, already);
    }
  }

  const arrivals: Arrival[] = [...changes.values()].map((one) => ({
    team: one.team, season: one.season,
    arriving: one.arriving, leaving: one.leaving,
    backs: one.carry.length,
    moved: {
      before: middle(one.before), after: middle(one.after),
      carry: middle(one.carry),
    },
  }));
  const seen = new Map<string, number>();

  for (const one of arrivals) {
    seen.set(one.arriving, (seen.get(one.arriving) ?? 0) + 1);
    seen.set(one.leaving, (seen.get(one.leaving) ?? 0) + 1);
  }

  console.log(
    `${arrivals.length} arrivals involving ${seen.size} coordinators, ` +
      `${[...seen.values()].filter((n) => n >= 2).length} of them ` +
      "in more than one\n",
  );
  console.log(
    "keeping each arrival back, does the difference between two levels\n" +
      "call how the backs moved?\n",
  );
  console.log(
    "  what moved          n   ordering    error   guessing no change   penalty",
  );

  for (const [label, of] of [
    ["before contact", (one: Arrival) => one.moved.before],
    ["after contact", (one: Arrival) => one.moved.after],
    ["yards a carry", (one: Arrival) => one.moved.carry],
  ] as [string, (one: Arrival) => number][]) {
    for (const penalty of [1, 4, 16]) {
      const said: number[] = [];
      const truth: number[] = [];

      for (const held of arrivals) {
        const rest = arrivals.filter(
          (one) => !(one.team === held.team && one.season === held.season),
        );

        // both men have to turn up elsewhere, or there is nothing to
        // say about this one
        if (
          !rest.some((o) => o.arriving === held.arriving || o.leaving === held.arriving) ||
          !rest.some((o) => o.arriving === held.leaving || o.leaving === held.leaving)
        ) {
          continue;
        }

        const level = levelsFrom(rest, of, penalty);
        said.push((level.get(held.arriving) ?? 0) - (level.get(held.leaving) ?? 0));
        truth.push(of(held));
      }

      if (said.length < 10) {
        console.log(
          "  " + label.padEnd(18) + String(said.length).padStart(4) +
            "   too few to say",
        );
        break;
      }

      console.log(
        "  " + label.padEnd(18) + String(said.length).padStart(4) +
          spearman(said, truth).toFixed(3).padStart(11) +
          rmse(said, truth).toFixed(3).padStart(9) +
          rmse(said.map(() => 0), truth).toFixed(3).padStart(21) +
          String(penalty).padStart(10),
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * When a coordinator arrives, does the running change?
 *
 * Correlating one back's yards with another's under the same
 * coordinator asks whether he collects similar backs, and the answer
 * came out zero. What matters instead is whether the same man, on the
 * same team, runs differently once a new coordinator has him.
 *
 * Two ways to see it. Within one arrival, do the backs affected all
 * move the same way. And across arrivals, does what a coordinator did
 * to one team's backs say what he will do to another's.
 *
 * Run: npx tsx scripts/coordinatorChangeEval.ts
 */

import { spearman } from "../src/backtest/metrics.js";
import { loadCoaches } from "../src/data/coaches.js";
import { loadRushingSeasons } from "../src/data/advancedStats.js";
import { asTeam } from "../src/features/runParts.js";

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Moved {
  /** the man, who is the same on both sides of the change */
  back: string;
  team: string;
  season: number;
  arriving: string;
  beforeChange: number;
  afterChange: number;
  carryChange: number;
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

  const moved: Moved[] = [];

  for (const [back, own] of byPlayer) {
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

      moved.push({
        back, team, season: season + 1, arriving,
        beforeChange: now.beforeContact - was.beforeContact,
        afterChange: now.afterContact - was.afterContact,
        carryChange: now.perCarry - was.perCarry,
      });
    }
  }

  const arrivals = new Map<string, Moved[]>();

  for (const one of moved) {
    const key = `${one.team}|${one.season}`;
    arrivals.set(key, [...(arrivals.get(key) ?? []), one]);
  }

  console.log(
    `${moved.length} backs who stayed while the coordinator changed, ` +
      `over ${arrivals.size} arrivals\n`,
  );

  const parts: [string, (one: Moved) => number][] = [
    ["before contact", (one) => one.beforeChange],
    ["after contact", (one) => one.afterChange],
    ["yards a carry", (one) => one.carryChange],
  ];

  console.log("do the backs at one arrival move together?\n");
  console.log("  what changed        n   his team-mates say   give or take");

  for (const [label, of] of parts) {
    const said: number[] = [];
    const truth: number[] = [];

    for (const together of arrivals.values()) {
      for (const one of together) {
        const others = together.filter((o) => o.back !== one.back);

        if (!others.length) {
          continue;
        }

        said.push(middle(others.map(of)));
        truth.push(of(one));
      }
    }

    console.log(
      "  " + label.padEnd(18) + String(said.length).padStart(4) +
        (said.length >= 8
          ? spearman(said, truth).toFixed(3).padStart(21) +
            noise(said.length).toFixed(3).padStart(15)
          : "   too few to say"),
    );
  }

  // and does what a coordinator did at one club say what he does at
  // the next
  const byCoordinator = new Map<string, { at: string; moved: Moved[] }[]>();

  for (const [key, together] of arrivals) {
    const who = together[0]!.arriving;
    byCoordinator.set(who, [
      ...(byCoordinator.get(who) ?? []), { at: key, moved: together },
    ]);
  }

  const twice = [...byCoordinator.values()].filter((list) => list.length >= 2);

  console.log(`\n${twice.length} coordinators arrived somewhere more than once\n`);

  if (twice.length < 4) {
    console.log("  too few to say anything");
  } else {
    console.log("  what he did last time      n   says what he does next   give or take");

    for (const [label, of] of parts) {
      const first: number[] = [];
      const next: number[] = [];

      for (const list of twice) {
        const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));

        for (let i = 1; i < sorted.length; i++) {
          first.push(middle(sorted[i - 1]!.moved.map(of)));
          next.push(middle(sorted[i]!.moved.map(of)));
        }
      }

      console.log(
        "  " + label.padEnd(25) + String(first.length).padStart(4) +
          (first.length >= 6
            ? spearman(first, next).toFixed(3).padStart(25) +
              noise(first.length).toFixed(3).padStart(15)
            : "   too few to say"),
      );
    }
  }

  // and how big the changes are at all, since one nobody can predict
  // is still worth knowing the size of
  console.log("\n  how far a coordinator change moves a back, in yards a carry\n");

  for (const [label, of] of parts) {
    console.log(
      "  " + label.padEnd(18) +
        middle(moved.map((one) => Math.abs(of(one)))).toFixed(2),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

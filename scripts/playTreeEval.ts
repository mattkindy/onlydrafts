/**
 * Everything on one play at once, so the interactions can be seen.
 *
 * Every question so far was asked of one thing at a time on season
 * totals: does a coordinator move a back, does a receiver keep his
 * yards. Season totals pool every front a man faced, and asking one
 * at a time misses anything that only shows up once the rest is held
 * still. So put the man, his quarterback, both sides and the
 * situation on the same row and let a tree say which of them it needs
 * and which it needs together.
 *
 * Run: npx tsx scripts/playTreeEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { loadCoaches } from "../src/data/coaches.js";
import { fitForest, predictForest, TREE_DEFAULTS } from "../src/model/boostedTrees.js";
import { buildDefenceOnField } from "../src/features/defenceOnField.js";
import type { Call } from "../src/model/playFactors.js";

const LEARN = [2022, 2023, 2024];
const SCORE_ON = 2025;

const NAMES = [
  "down", "to go", "yards to the goal", "the score", "seconds left",
  "it is a run", "his own yards", "how often he breaks a long one",
  "his quarterback's yards", "this offence's yards", "this defence's yards",
  "his coordinator changed", "he changed team", "his touches behind him",
  "the men on that defence this week",
  "his coordinator's own yards", "the coordinator before him",
];

interface Play {
  season: number;
  week: number;
  offence: string;
  defence: string;
  down: number;
  toGo: number;
  yardline: number;
  margin: number;
  secondsLeft: number;
  call: Call;
  player: string;
  passer: string;
  yards: number;
}

interface Tally {
  plays: number;
  yards: number;
  long: number;
}

const empty = (): Tally => ({ plays: 0, yards: 0, long: 0 });

const add = (into: Map<string, Tally>, key: string, yards: number) => {
  const own = into.get(key) ?? empty();
  own.plays++;
  own.yards += yards;
  if (yards >= 20) own.long++;
  into.set(key, own);
};

const per = (own: Tally | undefined, middle: number, steadyAt: number) => {
  if (!own || own.plays <= 0) {
    return middle;
  }

  const trust = own.plays / (own.plays + steadyAt);

  return trust * (own.yards / own.plays) + (1 - trust) * middle;
};

/** what was known going into a season, from the ones before it */
function knownBefore(
  plays: Play[], upTo: number, coaches: Map<string, string>,
) {
  const byMan = new Map<string, Tally>();
  const byPasser = new Map<string, Tally>();
  const byOffence = new Map<string, Tally>();
  const byDefence = new Map<string, Tally>();
  const byCoordinator = new Map<string, Tally>();
  const league = new Map<string, Tally>();
  const teamOf = new Map<string, string>();

  for (const play of plays) {
    if (play.season >= upTo) {
      continue;
    }

    add(league, play.call, play.yards);

    // the coordinator who called it, so the tree can be told which man
    // rather than only that the man changed
    const called = coaches.get(`${play.offence}|${play.season}|OC`);

    if (called) {
      add(byCoordinator, `${called}|${play.call}`, play.yards);
    }

    add(byOffence, `${play.offence}|${play.call}`, play.yards);
    add(byDefence, `${play.defence}|${play.call}`, play.yards);

    if (play.player) {
      add(byMan, `${play.player}|${play.call}`, play.yards);
      teamOf.set(play.player, play.offence);
    }

    if (play.passer) {
      add(byPasser, play.passer, play.yards);
    }
  }

  const middleOn = (call: Call) => {
    const own = league.get(call);
    return own && own.plays > 0 ? own.yards / own.plays : 5;
  };

  return {
    byMan, byPasser, byOffence, byDefence, byCoordinator, teamOf, middleOn,
    league,
  };
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const plays: Play[] = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ))
    .map((r) => ({
      season: Number(r["season"]), week: Number(r["week"]),
      offence: r["offense"] ?? "", defence: r["defense"] ?? "",
      down: Number(r["down"]), toGo: Number(r["togo"]),
      yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
      secondsLeft: Number(r["seconds"]) || 1800,
      call: (r["playType"] ?? "") as Call,
      player: r["player"] ?? "", passer: r["passer"] ?? "",
      yards: Number(r["yards"]) || 0,
    }))
    .filter((p) => p.player && (p.call === "run" || p.call === "pass"));

  console.log(`${plays.length} plays with somebody credited\n`);

  // the eleven who actually played, rather than the franchise
  const onField = await buildDefenceOnField({
    learn: [2022, 2023], describe: [2022, 2023, 2024, 2025],
  });
  console.log(
    `the on-field fit knows ${onField.knownMen} men over ${onField.weeks} ` +
      "team weeks\n",
  );

  const rowsFor = (season: number) => {
    const known = knownBefore(plays, season, coaches);
    const rows: number[][] = [];
    const target: number[] = [];

    for (const play of plays) {
      if (play.season !== season) {
        continue;
      }

      const middle = known.middleOn(play.call);
      const his = known.byMan.get(`${play.player}|${play.call}`);
      const passer = known.byPasser.get(play.passer);
      const passing = known.league.get("pass");
      const middlePass = passing && passing.plays > 0
        ? passing.yards / passing.plays : 6.5;
      const before = coaches.get(`${play.offence}|${play.season - 1}|OC`) ?? "";
      const now = coaches.get(`${play.offence}|${play.season}|OC`) ?? "";

      rows.push([
        play.down, play.toGo, play.yardline, play.margin, play.secondsLeft,
        play.call === "run" ? 1 : 0,
        per(his, middle, 60) / middle,
        his && his.plays > 0 ? his.long / his.plays : 0.05,
        play.passer ? per(passer, middlePass, 400) / middlePass : 1,
        per(known.byOffence.get(`${play.offence}|${play.call}`), middle, 200) / middle,
        per(known.byDefence.get(`${play.defence}|${play.call}`), middle, 200) / middle,
        before && now && before !== now ? 1 : 0,
        known.teamOf.has(play.player) &&
          known.teamOf.get(play.player) !== play.offence ? 1 : 0,
        his ? his.plays : 0,
        onField.weekOf(play.season, play.week, play.defence) ?? 0,
        per(known.byCoordinator.get(`${now}|${play.call}`), middle, 400) / middle,
        per(known.byCoordinator.get(`${before}|${play.call}`), middle, 400) / middle,
      ]);
      target.push(play.yards);
    }

    return { rows, target };
  };

  const learn = { rows: [] as number[][], target: [] as number[] };

  for (const season of LEARN) {
    const one = rowsFor(season);
    learn.rows.push(...one.rows);
    learn.target.push(...one.target);
  }

  const test = rowsFor(SCORE_ON);
  console.log(
    `learning on ${learn.rows.length} plays, scoring on ${test.rows.length}\n`,
  );

  const forest = fitForest({
    rows: learn.rows, target: learn.target, names: NAMES,
    settings: { ...TREE_DEFAULTS, trees: 150, depth: 4 },
  });
  const said = test.rows.map((row) => predictForest(forest, row));
  const flat = learn.target.reduce((a, b) => a + b, 0) / learn.target.length;

  console.log("guessing the yards on a play in 2025\n");
  console.log(
    "  the tree                 error " + rmse(said, test.target).toFixed(3) +
      "   ordering " + spearman(said, test.target).toFixed(4),
  );
  console.log(
    "  the same for every play  error " +
      rmse(test.rows.map(() => flat), test.target).toFixed(3),
  );

  const total = forest.credit.reduce((a, b) => a + b, 0);
  const ranked = forest.names
    .map((name, i) => ({ name, share: (forest.credit[i] ?? 0) / total }))
    .sort((a, b) => b.share - a.share);

  console.log("\nwhat the tree splits on, as a share of the error it removes\n");

  for (const one of ranked) {
    if (one.share < 0.005) {
      continue;
    }

    console.log("  " + one.name.padEnd(32) + (100 * one.share).toFixed(1) + "%");
  }

  const pairs = [...forest.pairCredit.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  console.log("\nand which pairs it asks about together, down one path\n");

  for (const [pair, credit] of pairs) {
    console.log("  " + pair.padEnd(52) + (100 * credit / total).toFixed(1) + "%");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

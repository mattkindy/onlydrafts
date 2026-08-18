/**
 * The model asked about the exact spots a season really visited.
 *
 * Everything checked so far is a marginal: how a drive ends over all
 * drives, how often a run goes inside over all runs. A model can get
 * every one of those right and still be wrong everywhere, by being
 * high in one corner and low in another. So walk the 2025 plays, ask
 * the model about each one where it stood, and see where it is off.
 *
 * Run: npx tsx scripts/playConditionEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import {
  realCounts, drawnCounts, type Whom,
} from "../src/features/comparablePlays.js";
import type { Call, PlayState } from "../src/model/playFactors.js";

const SCORE_ON = 2025;
const DRAWS = 30;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Cell {
  plays: number;
  reallyRan: number;
  reallyNothing: number;
  reallyFirst: number;
  reallyYards: number;
  saidRan: number;
  saidNothing: number;
  saidFirst: number;
  saidYards: number;
  draws: number;
}

const empty = (): Cell => ({
  plays: 0, reallyRan: 0, reallyNothing: 0, reallyFirst: 0, reallyYards: 0,
  saidRan: 0, saidNothing: 0, saidFirst: 0, saidYards: 0, draws: 0,
});

/** the corners of the game, cut coarsely enough to have counts */
const whereItStood = (p: {
  down: number; toGo: number; yardline: number; margin: number; secondsLeft: number;
}) => {
  const distance = p.toGo <= 2 ? "short" : p.toGo <= 7 ? "medium" : "long";
  const field = p.yardline <= 10 ? "at the goal"
    : p.yardline <= 40 ? "in range"
    : p.yardline <= 80 ? "midfield" : "backed up";
  const score = p.margin <= -9 ? "two scores down"
    : p.margin < 0 ? "behind"
    : p.margin === 0 ? "level"
    : p.margin < 9 ? "ahead" : "two scores up";
  const when = p.secondsLeft > 1800 ? "first half" : p.secondsLeft > 300 ? "third" : "late";

  return `${p.down} and ${distance}, ${field}, ${score}, ${when}`;
};

async function main(): Promise<void> {
  const raw = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const asRow = (r: Record<string, string>) => ({
    season: Number(r["season"]),
    offence: r["offense"] ?? "", defence: r["defense"] ?? "",
    down: Number(r["down"]), toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
    secondsLeft: Number(r["seconds"]) || 1800,
    call: (r["playType"] ?? "") as Call,
    yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
    player: r["player"] ?? "", passer: r["passer"] ?? "",
    airYards: r["airYards"] === "" || r["airYards"] === undefined
      ? undefined : Number(r["airYards"]),
  });
  const learn = raw.filter((r) => Number(r["season"]) < SCORE_ON).map(asRow);
  const held = raw.filter((r) => Number(r["season"]) === SCORE_ON).map(asRow);
  const factors = fitPlayFactors(learn as PlayRow[]);
  const rng = seededRng(41);
  const cells = new Map<string, Cell>();

  // over the plays somebody was credited with, on both sides, since
  // a pass pool has sacks in it and no receiver is credited with one
  const whom: Whom = "plays with a man on them";

  // every eleventh play, which is three thousand spots
  for (const play of held.filter((_, i) => i % 11 === 0)) {
    if (!realCounts(play, whom)) {
      continue;
    }

    const key = whereItStood(play);
    const cell = cells.get(key) ?? empty();
    cell.plays++;
    if (play.call === "run") cell.reallyRan++;
    if (play.yards <= 0) cell.reallyNothing++;
    if (play.yards >= play.toGo) cell.reallyFirst++;
    cell.reallyYards += play.yards;

    const state: PlayState = {
      down: play.down, toGo: play.toGo, yardline: play.yardline,
      margin: play.margin, secondsLeft: play.secondsLeft,
    };
    const sides = {
      offence: play.offence, defence: play.defence, passer: play.passer,
    };

    for (let i = 0; i < DRAWS; i++) {
      const ran = rng() < factors.runs(state, play.offence);
      const gained = Math.min(
        play.yardline,
        Math.round(factors.gains(state, ran ? "run" : "pass", play.player, rng, sides)),
      );

      if (!drawnCounts(ran ? "run" : "pass", gained, whom)) {
        continue;
      }

      cell.draws++;
      if (ran) cell.saidRan++;
      if (gained <= 0) cell.saidNothing++;
      if (gained >= play.toGo) cell.saidFirst++;
      cell.saidYards += gained;
    }

    cells.set(key, cell);
  }

  const worth = [...cells.entries()].filter(([, c]) => c.plays >= 25);
  console.log(
    `${worth.length} corners of the game with twenty five plays or more, ` +
      `out of ${cells.size}\n`,
  );

  const off = (cell: Cell) => ({
    ran: cell.saidRan / cell.draws - cell.reallyRan / cell.plays,
    nothing: cell.saidNothing / cell.draws - cell.reallyNothing / cell.plays,
    first: cell.saidFirst / cell.draws - cell.reallyFirst / cell.plays,
    yards: cell.saidYards / cell.draws - cell.reallyYards / cell.plays,
  });

  // the simplest cut first, since if it is wrong per down nothing
  // below it is worth reading
  const byDown = new Map<number, Cell>();

  for (const [key, cell] of cells) {
    const down = Number(key.split(" ")[0]);
    const own = byDown.get(down) ?? empty();
    own.plays += cell.plays;
    own.reallyRan += cell.reallyRan;
    own.reallyNothing += cell.reallyNothing;
    own.reallyFirst += cell.reallyFirst;
    own.reallyYards += cell.reallyYards;
    own.saidRan += cell.saidRan;
    own.saidNothing += cell.saidNothing;
    own.saidFirst += cell.saidFirst;
    own.saidYards += cell.saidYards;
    own.draws += cell.draws;
    byDown.set(down, own);
  }

  console.log("by down, over every spot it came up in\n");
  console.log(
    "  down   plays      runs            gains nothing      " +
      "gets a first        yards",
  );

  for (const down of [1, 2, 3, 4]) {
    const cell = byDown.get(down);

    if (!cell || cell.plays < 50) {
      continue;
    }

    const pair = (said: number, really: number) =>
      `${(100 * said / cell.draws).toFixed(0)}% v ${(100 * really / cell.plays).toFixed(0)}%`;
    console.log(
      `  ${down}   ` + String(cell.plays).padStart(6) +
        pair(cell.saidRan, cell.reallyRan).padStart(16) +
        pair(cell.saidNothing, cell.reallyNothing).padStart(19) +
        pair(cell.saidFirst, cell.reallyFirst).padStart(19) +
        `   ${(cell.saidYards / cell.draws).toFixed(1)} v ` +
        `${(cell.reallyYards / cell.plays).toFixed(1)}`,
    );
  }

  console.log("\nhow far off it is, across those corners, as an average size\n");
  const every = worth.map(([, c]) => off(c));
  console.log(
    `  runs             ${(100 * middle(every.map((o) => Math.abs(o.ran)))).toFixed(1)}%` +
    `\n  gains nothing    ${(100 * middle(every.map((o) => Math.abs(o.nothing)))).toFixed(1)}%` +
    `\n  gets a first     ${(100 * middle(every.map((o) => Math.abs(o.first)))).toFixed(1)}%` +
    `\n  yards            ${middle(every.map((o) => Math.abs(o.yards))).toFixed(2)}`,
  );

  // and pooled by where on the field, since the worst corners all
  // looked like midfield and that wants checking on its own
  const byZone = new Map<string, Cell>();

  for (const [key, cell] of cells) {
    const zone = key.split(", ")[1] ?? "";
    const own = byZone.get(zone) ?? empty();
    own.plays += cell.plays;
    own.reallyNothing += cell.reallyNothing;
    own.reallyFirst += cell.reallyFirst;
    own.reallyYards += cell.reallyYards;
    own.saidNothing += cell.saidNothing;
    own.saidFirst += cell.saidFirst;
    own.saidYards += cell.saidYards;
    own.draws += cell.draws;
    byZone.set(zone, own);
  }

  console.log("\nby where on the field\n");
  console.log("  where            plays   gains nothing      gets a first        yards");

  for (const [zone, cell] of [...byZone.entries()].sort((a, b) => b[1].plays - a[1].plays)) {
    if (cell.plays < 100) {
      continue;
    }

    const pair = (said: number, really: number) =>
      `${(100 * said / cell.draws).toFixed(0)}% v ${(100 * really / cell.plays).toFixed(0)}%`;
    console.log(
      "  " + zone.padEnd(16) + String(cell.plays).padStart(6) +
        pair(cell.saidNothing, cell.reallyNothing).padStart(16) +
        pair(cell.saidFirst, cell.reallyFirst).padStart(19) +
        `   ${(cell.saidYards / cell.draws).toFixed(1)} v ` +
        `${(cell.reallyYards / cell.plays).toFixed(1)}`,
    );
  }

  for (const [what, of] of [
    ["running too much or too little", (o: ReturnType<typeof off>) => o.ran],
    ["first downs", (o: ReturnType<typeof off>) => o.first],
    ["yards", (o: ReturnType<typeof off>) => o.yards],
  ] as [string, (o: ReturnType<typeof off>) => number][]) {
    const ranked = worth
      .map(([key, cell]) => ({ key, cell, gap: of(off(cell)) }))
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
      .slice(0, 5);

    console.log(`\nworst on ${what}\n`);

    for (const one of ranked) {
      const scale = what === "yards" ? 1 : 100;
      const mark = what === "yards" ? "" : "%";
      console.log(
        "  " + one.key.padEnd(46) + String(one.cell.plays).padStart(5) +
          " plays   " + (scale * one.gap).toFixed(1).padStart(6) + mark,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

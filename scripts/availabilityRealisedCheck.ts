/**
 * Does the season sim play out the games the availability model
 * expects, or does the hazard process discount them further?
 *
 * predictAvailability sets each man's expectedGames inside
 * buildPreseasonWorld, and sim.games in docs/data/board-2026.json is
 * the mean, across 2000 replays, of the games-played draws
 * simulatePlayerSeasons makes from that expectation through
 * fitAbsence's hazard process. This rebuilds the world to read
 * expectedGames straight off it and compares that to shipped
 * sim.games. Rookies are left out: the availability model sets no
 * expectation for a man with no prior season.
 * Run: npx tsx scripts/availabilityRealisedCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPreseasonWorld } from "../src/features/preseason.js";
import { normalizeName } from "../src/data/names.js";

const SEASON = 2026;

interface BoardEntry {
  name: string;
  key: string;
  position: string;
  team: string;
  sim?: { games: number } | null;
  rookie?: boolean;
}

const mean = (its: number[]) =>
  its.length ? its.reduce((a, b) => a + b, 0) / its.length : 0;

async function main(): Promise<void> {
  const boardPath = join(
    import.meta.dirname, "..", "docs", "data", `board-${SEASON}.json`,
  );
  const board = JSON.parse(await readFile(boardPath, "utf8")) as {
    season: number;
    players: BoardEntry[];
  };

  console.log("building the preseason world for 2026 (this takes a while)...");
  const world = await buildPreseasonWorld(SEASON);

  const predictedByKey = new Map<string, { predicted: number; position: string }>();

  for (const p of world.players) {
    if (p.expectedGames === undefined) {
      continue;
    }

    predictedByKey.set(normalizeName(p.name), {
      predicted: p.expectedGames, position: p.position,
    });
  }

  interface Pair { name: string; position: string; predicted: number; realised: number; }
  const pairs: Pair[] = [];

  for (const e of board.players) {
    const said = predictedByKey.get(e.key);

    if (!said || !e.sim || e.rookie) {
      continue;
    }

    pairs.push({
      name: e.name, position: e.position,
      predicted: said.predicted, realised: e.sim.games,
    });
  }

  console.log(`\nmatched ${pairs.length} of ${board.players.length} board men`);
  console.log("(no match: rookies, and anyone the board dropped or renamed)");

  console.log("\nby position");
  console.log("pos    n   we expect   sim played   gap (expect - sim)");

  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const its = pairs.filter((p) => p.position === pos);

    if (!its.length) {
      continue;
    }

    const said = its.map((p) => p.predicted);
    const did = its.map((p) => p.realised);

    console.log(
      `${pos.padEnd(4)} ${String(its.length).padStart(4)}   ` +
      `${mean(said).toFixed(2).padStart(7)}   ${mean(did).toFixed(2).padStart(9)}` +
      `   ${(mean(said) - mean(did)).toFixed(2).padStart(6)}`,
    );
  }

  console.log("\nby predicted-games band");
  console.log("band          n   we expect   sim played   gap (expect - sim)");
  const bands: [string, (g: number) => boolean][] = [
    ["1 to 8", (g) => g <= 8],
    ["9 to 11", (g) => g > 8 && g <= 11],
    ["12 to 13", (g) => g > 11 && g <= 13],
    ["14 to 15", (g) => g > 13 && g <= 15],
    ["16 to 17", (g) => g > 15],
  ];

  for (const [label, inBand] of bands) {
    const its = pairs.filter((p) => inBand(p.predicted));

    if (!its.length) {
      continue;
    }

    const said = its.map((p) => p.predicted);
    const did = its.map((p) => p.realised);

    console.log(
      `${label.padEnd(12)} ${String(its.length).padStart(4)}   ` +
      `${mean(said).toFixed(2).padStart(7)}   ${mean(did).toFixed(2).padStart(9)}` +
      `   ${(mean(said) - mean(did)).toFixed(2).padStart(6)}`,
    );
  }

  const overallGap = mean(pairs.map((p) => p.predicted)) -
    mean(pairs.map((p) => p.realised));
  console.log(
    `\noverall: model expects ${mean(pairs.map((p) => p.predicted)).toFixed(2)}, ` +
    `sim plays ${mean(pairs.map((p) => p.realised)).toFixed(2)}, ` +
    `gap ${overallGap.toFixed(2)} games` +
    (overallGap > 0 ? " (the sim realises fewer games than the model predicts)"
      : " (the sim realises more games than the model predicts)"),
  );

  console.log("\nthe 15 biggest gaps, either direction");
  console.log("name                 pos   we expect   sim played   gap");
  const worst = [...pairs]
    .sort((a, b) => Math.abs(b.predicted - b.realised) - Math.abs(a.predicted - a.realised))
    .slice(0, 15);

  for (const p of worst) {
    console.log(
      `${p.name.padEnd(20)} ${p.position.padEnd(4)}  ` +
      `${p.predicted.toFixed(2).padStart(7)}   ${p.realised.toFixed(2).padStart(9)}` +
      `   ${(p.predicted - p.realised).toFixed(2).padStart(6)}`,
    );
  }
}

await main();

/**
 * Whether a man's attributes say what his plays will look like.
 *
 * Carrying his long play rate forward is a summary statistic picked by
 * hand. He already has thirty four attributes and those ought to say
 * it, and unlike his own history they say it for a man who has none.
 *
 * Run: npx tsx scripts/attributeShapeEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { buildPlayerVectors, ATTRIBUTES } from "../src/features/playerVector.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface Own {
  touches: number;
  yards: number;
  long: number;
}

async function seasonOf(season: number): Promise<Map<string, Own>> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).filter((r) => Number(r["season"]) === season && r["player"]);
  const tally = new Map<string, Own>();

  for (const row of rows) {
    const own = tally.get(row["player"]!) ?? { touches: 0, yards: 0, long: 0 };
    const gained = Number(row["yards"]) || 0;
    own.touches++;
    own.yards += gained;
    if (gained >= 20) own.long++;
    tally.set(row["player"]!, own);
  }

  return tally;
}

async function main(): Promise<void> {
  const before = await seasonOf(2024);
  const now = await seasonOf(2025);
  const vectors = await buildPlayerVectors(2024);
  const position = new Map<string, string>();

  for (const s of await loadPlayerStats(2025)) {
    position.set(s.playerId, s.position);
  }

  const men = [...now].filter(([player, own]) =>
    own.touches >= 40 && (before.get(player)?.touches ?? 0) >= 40 &&
    vectors.has(player) && ["RB", "WR", "TE"].includes(position.get(player) ?? ""));
  console.log(`${men.length} men with forty touches both seasons and a description\n`);

  const rate = (own: Own) => own.long / own.touches;
  const truth = men.map(([, own]) => rate(own));
  const was = men.map(([player]) => rate(before.get(player)!));

  // fitted on the earlier pair, so the weights never see this one
  const older = await seasonOf(2023);
  const learnOn = [...before].filter(([player, own]) =>
    own.touches >= 40 && (older.get(player)?.touches ?? 0) >= 40 &&
    vectors.has(player));
  const rowFor = (player: string) => [1, ...vectors.get(player)!.values];
  const weights = fitRidge(
    learnOn.map(([player]) => rowFor(player)),
    learnOn.map(([, own]) => rate(own)),
    2,
  );
  const fromAttributes = men.map(([player]) => predictRidge(weights, rowFor(player)));

  console.log("guessing how often he breaks a twenty   spearman");
  console.log(
    "  from his own rate before      " + spearman(was, truth).toFixed(4).padStart(7) +
    "\n  from his attributes           " +
    spearman(fromAttributes, truth).toFixed(4).padStart(7) +
    "\n  from both, added as places    " +
    spearman(
      men.map(() => {
        const place = (values: number[]) => {
          const order = values.map((v, j) => ({ v, j })).sort((a, b) => b.v - a.v);
          const out = new Array<number>(values.length);
          order.forEach((o, at) => { out[o.j] = at + 1; });
          return out;
        };
        void place;
        return 0;
      }).map((_, i) => -(rankOf(was)[i]! + rankOf(fromAttributes)[i]!)),
      truth,
    ).toFixed(4).padStart(7) +
    `\n  give or take ${noise(men.length).toFixed(3)}, on ${learnOn.length} men fitted`,
  );

  // and the men his own history cannot speak for
  const fresh = [...now].filter(([player, own]) =>
    own.touches >= 40 && (before.get(player)?.touches ?? 0) < 10 && vectors.has(player));
  console.log(
    `\n  ${fresh.length} men with nothing behind them, where only the attributes speak`,
  );
  void ATTRIBUTES;
  void middle;
}

function rankOf(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const out = new Array<number>(values.length);
  order.forEach((o, at) => { out[o.i] = at + 1; });
  return out;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

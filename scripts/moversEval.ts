/**
 * Would knowing what a team paid tell us what they want from him?
 *
 * The model matches the room on men who stayed put and falls apart on
 * men who moved, since a mover's history is on a team he no longer
 * plays for. Money is the obvious thing that would say whether he was
 * brought in to start. The contract file stops at 2022, so this asks
 * the question of the 2022 season, where it still has something to say.
 *
 * Run: npx tsx scripts/moversEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { dealFor, loadContracts } from "../src/data/contracts.js";

const SCORE_ON = 2022;

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface Year {
  playerId: string;
  name: string;
  position: string;
  team: string;
  touches: number;
  share: number;
}

async function seasonOf(season: number): Promise<Map<string, Year>> {
  const plays = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== season) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    plays.set(row["offense"] ?? "", (plays.get(row["offense"] ?? "") ?? 0) + 1);
  }

  const tally = new Map<string, Year>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    const own = tally.get(s.playerId) ?? {
      playerId: s.playerId, name: s.playerName, position: s.position,
      team: s.teamId, touches: 0, share: 0,
    };
    own.touches += s.carries + s.targets;
    own.team = s.teamId;
    tally.set(s.playerId, own);
  }

  for (const own of tally.values()) {
    own.share = own.touches / (plays.get(own.team) ?? 1000);
  }

  return tally;
}

async function main(): Promise<void> {
  const before = await seasonOf(SCORE_ON - 1);
  const now = await seasonOf(SCORE_ON);
  const contracts = await loadContracts();

  const movers: { man: Year; was: Year; capShare: number }[] = [];
  const stayers: { man: Year; was: Year; capShare: number }[] = [];

  for (const man of now.values()) {
    const was = before.get(man.playerId);

    if (!was) {
      continue;
    }

    const deal = dealFor(contracts, man.name, man.position, SCORE_ON);

    if (!deal) {
      continue;
    }

    (was.team === man.team ? stayers : movers).push({
      man, was, capShare: deal.capShare,
    });
  }

  console.log(
    `${SCORE_ON}: ${movers.length} men who changed teams and ` +
      `${stayers.length} who did not, with a deal on file\n`,
  );

  for (const [label, set] of [
    ["men who moved", movers], ["men who stayed", stayers],
  ] as [string, typeof movers][]) {
    if (set.length < 12) continue;
    const truth = set.map((r) => r.man.share);
    console.log(
      label + `, guessing his share (${set.length} men)` +
      "\n  his share on his old team   " +
      spearman(set.map((r) => r.was.share), truth).toFixed(4) +
      "\n  what he is being paid       " +
      spearman(set.map((r) => r.capShare), truth).toFixed(4) +
      "\n  both, added as places       " +
      spearman(
        set.map((r, i) => {
          void i;
          return r.was.share;
        }).map((v, i) => v * 0 + rankMix(set, i)),
        truth,
      ).toFixed(4) +
      `\n  give or take ${noise(set.length).toFixed(3)}\n`,
    );
  }
}

/** the two put together as places, since money and share do not share a scale */
function rankMix(
  set: { was: Year; capShare: number }[], at: number,
): number {
  const place = (values: number[]) => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const out = new Array<number>(values.length);
    order.forEach((o, rank) => { out[o.i] = rank + 1; });
    return out;
  };
  const byShare = place(set.map((r) => r.was.share));
  const byMoney = place(set.map((r) => r.capShare));

  return -(byShare[at]! + byMoney[at]!);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

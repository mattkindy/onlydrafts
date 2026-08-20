/**
 * Two questions the walk answers every play, scored play by play.
 *
 * Whether the call is a run, and who touches it, have only ever been
 * checked as rates. This asks them of every 2025 play the model could
 * have seen: how sure was it, was it right, and does it beat knowing
 * only the down and each man's season share.
 *
 * Run: npx tsx scripts/callAndToucherEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { fitSwings } from "../src/features/fitSwing.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import { countsFor } from "../src/features/countsCache.js";
import {
  experienceBefore, pastShares, projectSplitShares, SHARING_POSITIONS,
} from "../src/features/projectedShares.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import type { Call, PlayState } from "../src/model/playFactors.js";

const SCORE_ON = 2025;

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
  });
  const learn = raw.filter((r) => Number(r["season"]) < SCORE_ON).map(asRow);
  const held = raw.filter((r) => Number(r["season"]) === SCORE_ON).map(asRow);

  const positions = new Map<string, string>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  const swings = await fitSwings(SCORE_ON - 1, positions);
  const { byTeam } = await fitRoles(
    SCORE_ON - 1, positions, played, 17, undefined, swings,
  );
  const teamPlays = new Map<string, number>();

  for (const r of raw) {
    if (["run", "pass"].includes(r["playType"] ?? "")) {
      const key = `${r["season"]}|${r["offense"]}`;
      teamPlays.set(key, (teamPlays.get(key) ?? 0) + 1);
    }
  }

  const roster = [...byTeam.entries()].flatMap(([team, men]) =>
    men
      .filter((p) => SHARING_POSITIONS.includes(p.position))
      .map((p) => ({ playerId: p.playerId, position: p.position, team })),
  );
  const split = projectSplitShares({
    season: SCORE_ON,
    roster,
    past: await pastShares(
      [SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1],
      (s, team) => teamPlays.get(`${s}|${team}`) ?? 1000,
    ),
    picks: await loadDraftPicks(),
    experience: await experienceBefore(SCORE_ON),
  });
  const counted = await countsFor(SCORE_ON, () => learn as PlayRow[]);
  const factors = fitPlayFactors([], undefined, { counted, split });

  const amongOf = new Map<string, string[]>();

  for (const [team, men] of byTeam) {
    amongOf.set(
      team,
      men.filter((p) => SHARING_POSITIONS.includes(p.position))
        .map((p) => p.playerId),
    );
  }

  // the down-and-distance baseline for the call, from the same seasons
  const byDown = new Map<string, { plays: number; runs: number }>();

  for (const r of learn) {
    const key = `${r.down}|${Math.min(10, r.toGo)}`;
    const own = byDown.get(key) ?? { plays: 0, runs: 0 };
    own.plays++;
    if (r.call === "run") own.runs++;
    byDown.set(key, own);
  }

  let calls = 0;
  let rightCall = 0;
  let rightBaseline = 0;
  let brier = 0;
  let brierBaseline = 0;
  let touches = 0;
  let covered = 0;
  let top1 = 0;
  let top1Share = 0;
  let saidP = 0;
  let shareP = 0;
  let uniformP = 0;

  for (const play of held.filter((_, i) => i % 3 === 0)) {
    const state: PlayState = {
      down: play.down, toGo: play.toGo, yardline: play.yardline,
      margin: play.margin, secondsLeft: play.secondsLeft,
    };
    const pRun = factors.runs(state, play.offence);
    const base = byDown.get(`${play.down}|${Math.min(10, play.toGo)}`);
    const pBase = base ? base.runs / base.plays : 0.42;
    const ran = play.call === "run" ? 1 : 0;
    calls++;
    if ((pRun >= 0.5) === (ran === 1)) rightCall++;
    if ((pBase >= 0.5) === (ran === 1)) rightBaseline++;
    brier += (pRun - ran) ** 2;
    brierBaseline += (pBase - ran) ** 2;

    // and who, among the men the model was given
    const among = amongOf.get(play.offence);

    if (!among || !play.player) {
      continue;
    }

    touches++;

    if (!among.includes(play.player)) {
      continue;
    }

    covered++;
    const shares = factors.goesTo(state, play.call, among);
    const best = [...shares.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[0] === play.player) top1++;
    saidP += shares.get(play.player) ?? 0;
    uniformP += 1 / among.length;

    // the season-share baseline, no situation in it
    const flat = among.map((id) => {
      const s = split.get(id);
      return [id, s ? (play.call === "run" ? s.carries : s.targets) : 0] as const;
    });
    const total = flat.reduce((a, [, v]) => a + v, 0);
    const bestFlat = [...flat].sort((a, b) => b[1] - a[1])[0];
    if (bestFlat && bestFlat[0] === play.player) top1Share++;
    shareP += total > 0
      ? (flat.find(([id]) => id === play.player)?.[1] ?? 0) / total
      : 1 / among.length;
  }

  console.log(`${calls} plays asked about\n`);
  console.log("was it a run?\n");
  console.log(
    "  the walk        right " + (100 * rightCall / calls).toFixed(1) +
      "%   brier " + (brier / calls).toFixed(4),
  );
  console.log(
    "  down and distance only   right " + (100 * rightBaseline / calls).toFixed(1) +
      "%   brier " + (brierBaseline / calls).toFixed(4),
  );
  console.log(
    `\nwho touched it, over the ${covered} of ${touches} touches where the ` +
      "man was on the roster it was given\n",
  );
  console.log(
    "  the walk picked him first    " + (100 * top1 / covered).toFixed(1) +
      "%   and gave what happened p=" + (saidP / covered).toFixed(3),
  );
  console.log(
    "  season share alone           " + (100 * top1Share / covered).toFixed(1) +
      "%   and gave it            p=" + (shareP / covered).toFixed(3),
  );
  console.log(
    "  picking at random            " + (100 * uniformP / covered).toFixed(1) + "%",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// One-off diagnostic: how many eligible skill players match a snap
// count row when joined on normalized name plus team.
// Run: npx tsx scripts/snapJoinCheck.ts

import { loadPlayerStats, loadSnapCounts } from "../src/data/nflverse.js";
import { normalizeName } from "../src/data/names.js";
import { summarizeSeason } from "../src/features/seasonSummary.js";
import { presets } from "../src/scoring/fantasyPoints.js";

const stats = await loadPlayerStats(2023);
const summaries = summarizeSeason(stats, presets.ppr);
const snaps = await loadSnapCounts(2023);
const keys = new Set(
  snaps.map((s) => `${normalizeName(s.playerName)}|${s.teamId}`),
);

let matched = 0;
let total = 0;

for (const s of summaries.values()) {
  if (!["QB", "RB", "WR", "TE"].includes(s.position) || s.games < 6) {
    continue;
  }

  total++;

  if (keys.has(`${normalizeName(s.playerName)}|${s.primaryTeamId}`)) {
    matched++;
  }
}

console.log(`snap join: ${matched}/${total} skill players matched`);

/**
 * Snapshots a Fantasy Football Calculator draft board into the committed
 * ADP folder, which loadAdp reads before the raw downloads. Run it in the
 * last week before a season.
 *
 * It will not replace a board already there without --force. The site
 * serves only the last week of drafts, so a second pull in October would
 * swap the preseason room for a different one.
 *
 * Run: npx tsx scripts/pullAdp.ts <season> [ppr|standard] [--force]
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { ADP_DIR, mockBoardFile, type AdpFormat } from "../src/data/adp.js";
import { fetchWithRetry } from "../src/data/fetchWithRetry.js";
import { writeAtomically } from "../src/data/writeAtomically.js";

const [seasonArg, formatArg] = process.argv.slice(2)
  .filter((a) => !a.startsWith("--"));
const season = Number(seasonArg ?? new Date().getFullYear());
const format = (formatArg ?? "standard") as AdpFormat;
const out = join(ADP_DIR, mockBoardFile(format, season));
const already = await access(out).then(() => true, () => false);

if (already && !process.argv.includes("--force")) {
  throw new Error(`${out} is already there; pass --force to replace it`);
}

const url = "https://fantasyfootballcalculator.com/api/v1/adp/" +
  `${format}?teams=12&year=${season}&position=all`;
const body = await fetchWithRetry(url, { label: `${format} board ${season}` })
  .then((r) => r.json());

if (body.status !== "Success") {
  throw new Error(`no board for ${season}`);
}

// The spread and the draft count come through because the market price
// model asks whether a room that argued about a player was telling you
// something. Boards pulled before this was added have neither.
const players = body.players.map((p: any) => ({
  name: p.name, position: p.position, adp: p.adp,
  high: p.high, low: p.low,
  stdev: p.stdev, times_drafted: p.times_drafted,
}));
await writeAtomically(out, JSON.stringify({ meta: body.meta, players }, null, 2));
console.log(`${out}: ${players.length} players from ${body.meta.total_drafts} drafts`);

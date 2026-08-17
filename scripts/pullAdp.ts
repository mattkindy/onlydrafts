// Snapshots a Fantasy Football Calculator draft board into data/raw,
// which is where loadAdp reads it from.
//
// Run: npx tsx scripts/pullAdp.ts <season> [ppr|standard]
import { writeFile } from "node:fs/promises";

const season = Number(process.argv[2] ?? new Date().getFullYear());
const format = process.argv[3] ?? "standard";
const url = "https://fantasyfootballcalculator.com/api/v1/adp/" +
  `${format}?teams=12&year=${season}&position=all`;
const body = await fetch(url).then((r) => r.json());

if (body.status !== "Success") throw new Error(`no board for ${season}`);

const players = body.players.map((p: any) => ({
  name: p.name, position: p.position, adp: p.adp,
  high: p.high, low: p.low,
}));
const out = `data/raw/adp_${format}_${season}.json`;
await writeFile(out, JSON.stringify({ meta: body.meta, players }, null, 2));
console.log(`${out}: ${players.length} players from ${body.meta.total_drafts} drafts`);

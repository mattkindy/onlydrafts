/**
 * Does where a game is played show up in who gets hurt?
 *
 * The material underfoot came to nothing, 20.8% on grass against 19.4%
 * on turf. A particular ground is a different question: some have a
 * name for it, and altitude and cold are places rather than surfaces.
 *
 * Run: npx tsx scripts/stadiumEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv, splitLine } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";

const SEASONS = [2019, 2021, 2022, 2023, 2024, 2025];

async function main(): Promise<void> {
  const lines = (await readFile(join(RAW_DIR, "games.csv"), "utf8")).split("\n");
  const header = splitLine(lines[0]!);
  const at = (name: string) => header.indexOf(name);
  const where = new Map<string, { stadium: string; roof: string; home: boolean }>();

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const c = splitLine(line);
    const season = Number(c[at("season")]);
    if (!SEASONS.includes(season)) continue;
    const spot = {
      stadium: c[at("stadium")] ?? "",
      roof: c[at("roof")] ?? "",
    };
    where.set(`${season}|${c[at("week")]}|${c[at("home_team")]}`, { ...spot, home: true });
    where.set(`${season}|${c[at("week")]}|${c[at("away_team")]}`, { ...spot, home: false });
  }

  const tally = new Map<string, { out: number; listed: number }>();
  const visiting = new Map<string, { out: number; listed: number }>();
  const byRoof = new Map<string, { out: number; listed: number }>();

  for (const season of SEASONS) {
    const rows = parseCsv(
      await readFile(join(RAW_DIR, `injuries_${season}.csv`), "utf8"),
    ).filter((r) => ["RB", "WR", "TE"].includes(r["position"] ?? ""));

    for (const row of rows) {
      const spot = where.get(`${season}|${row["week"]}|${row["team"]}`);

      if (!spot || !spot.stadium) {
        continue;
      }

      const ruled = (row["report_status"] ?? "") === "Out" ? 1 : 0;
      const own = tally.get(spot.stadium) ?? { out: 0, listed: 0 };
      own.listed++;
      own.out += ruled;
      tally.set(spot.stadium, own);

      // Most listings at a ground belong to the side that plays there
      // every week, so a ground that looks harsh may only be a club
      // that reports carefully. Visitors separate the two.
      if (!spot.home) {
        const away = visiting.get(spot.stadium) ?? { out: 0, listed: 0 };
        away.listed++;
        away.out += ruled;
        visiting.set(spot.stadium, away);
      }

      const roof = /dome|closed/i.test(spot.roof) ? "indoors" : "outdoors";
      const byIt = byRoof.get(roof) ?? { out: 0, listed: 0 };
      byIt.listed++;
      byIt.out += ruled;
      byRoof.set(roof, byIt);
    }
  }

  console.log("men on the injury list who were ruled out\n");

  for (const [roof, own] of byRoof) {
    console.log(
      "  " + roof.padEnd(10) + (100 * own.out / own.listed).toFixed(1) +
      "%  of " + own.listed,
    );
  }

  const big = [...tally].filter(([, own]) => own.listed >= 250)
    .map(([stadium, own]) => ({ stadium, rate: own.out / own.listed, seen: own.listed }))
    .sort((a, b) => b.rate - a.rate);
  const league = big.reduce((a, s) => a + s.rate * s.seen, 0) /
    big.reduce((a, s) => a + s.seen, 0);

  console.log(
    `\n${big.length} grounds with 250 listings or more, league ` +
      `${(100 * league).toFixed(1)}%\n`,
  );
  console.log("  ground                          out   listings");

  for (const spot of [...big.slice(0, 5), ...big.slice(-5)]) {
    console.log(
      "  " + spot.stadium.slice(0, 30).padEnd(32) +
      (100 * spot.rate).toFixed(1) + "%" + String(spot.seen).padStart(9),
    );
  }

  // the same, counting only the sides who do not play there
  const away = [...visiting].filter(([, own]) => own.listed >= 120)
    .map(([stadium, own]) => ({ stadium, rate: own.out / own.listed, seen: own.listed }));
  const awayLeague = away.reduce((a, s) => a + s.rate * s.seen, 0) /
    away.reduce((a, s) => a + s.seen, 0);
  const awaySpread = Math.sqrt(
    away.reduce((a, s) => a + (s.rate - awayLeague) ** 2, 0) / away.length,
  );
  const awayChance = Math.sqrt(
    awayLeague * (1 - awayLeague) /
      (away.reduce((a, s) => a + s.seen, 0) / away.length),
  );
  console.log(
    `\n  counting only visiting sides, ${away.length} grounds: they differ by ` +
      `${(100 * awaySpread).toFixed(1)} points where chance would give ` +
      `${(100 * awayChance).toFixed(1)}`,
  );

  // how far apart the grounds are, against how far chance would put them
  const spread = Math.sqrt(
    big.reduce((a, s) => a + (s.rate - league) ** 2, 0) / big.length,
  );
  const byChance = Math.sqrt(
    league * (1 - league) / (big.reduce((a, s) => a + s.seen, 0) / big.length),
  );
  console.log(
    `\n  grounds differ by ${(100 * spread).toFixed(1)} points where chance alone ` +
      `would give ${(100 * byChance).toFixed(1)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

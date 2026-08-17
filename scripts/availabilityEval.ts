/**
 * Whether missing games can be seen coming.
 *
 * A season of points is a man's rate times his work times how many
 * games he is there for, and the model treats that last part as one
 * number per player carried over from last season. Three things are
 * worth asking of it: does a man who missed games miss them again, does
 * a heavy workload cost him games afterwards, and does the ground he
 * plays on matter.
 *
 * Run: npx tsx scripts/availabilityEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadGames, loadPlayerStats, RAW_DIR } from "../src/data/nflverse.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface Year {
  games: number;
  touches: number;
  position: string;
  team: string;
}

async function seasonOf(season: number): Promise<Map<string, Year>> {
  const tally = new Map<string, Year>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    const own = tally.get(s.playerId) ??
      { games: 0, touches: 0, position: s.position, team: s.teamId };
    own.games++;
    own.touches += s.carries + s.targets;
    own.team = s.teamId;
    tally.set(s.playerId, own);
  }

  return tally;
}

async function main(): Promise<void> {
  const years = new Map<number, Map<string, Year>>();

  for (const season of [2021, 2022, 2023, 2024, 2025]) {
    years.set(season, await seasonOf(season));
  }

  // does a man who missed games miss them again
  const pairs: { before: Year; after: Year }[] = [];

  for (const season of [2022, 2023, 2024, 2025]) {
    const was = years.get(season - 1)!;
    const now = years.get(season)!;

    for (const [playerId, after] of now) {
      const before = was.get(playerId);
      if (before && before.games >= 4) pairs.push({ before, after });
    }
  }

  console.log(`${pairs.length} men with two seasons in a row\n`);
  console.log(
    "games played, one season against the next   " +
    spearman(
      pairs.map((p) => p.before.games), pairs.map((p) => p.after.games),
    ).toFixed(4) + ` give or take ${noise(pairs.length).toFixed(3)}`,
  );

  // does last season's workload cost him games this one
  const heavy = pairs.filter((p) => p.before.games >= 12);
  console.log(
    "last season's touches against games this one " +
    spearman(
      heavy.map((p) => p.before.touches), heavy.map((p) => p.after.games),
    ).toFixed(4) + ` on ${heavy.length} men who played twelve or more`,
  );

  // and by how much work he had, in bands
  const bands: [string, (touches: number) => boolean][] = [
    ["under 100", (t) => t < 100],
    ["100 to 200", (t) => t >= 100 && t < 200],
    ["200 to 300", (t) => t >= 200 && t < 300],
    ["300 and up", (t) => t >= 300],
  ];

  console.log("\nlast season's work, and games played the next");
  console.log("  touches       games   men");

  for (const [label, keep] of bands) {
    const at = heavy.filter((p) => keep(p.before.touches));

    if (at.length < 20) {
      continue;
    }

    console.log(
      "  " + label.padEnd(14) + middle(at.map((p) => p.after.games)).toFixed(1) +
      String(at.length).padStart(7),
    );
  }

  /**
   * A season share is touches over a whole offence's plays, so a man
   * who missed half the year looks like a smaller part of his offence
   * rather than the same part of fewer games. Those want separating: a
   * role he holds when he plays, and how often he plays.
   */
  const perGame = pairs.filter((p) => p.before.games >= 4 && p.after.games >= 4);
  const rate = (year: Year) => year.touches / year.games;

  console.log(
    "\ncarried from one season to the next" +
    "\n  his touches over the season      " +
    spearman(
      perGame.map((p) => p.before.touches), perGame.map((p) => p.after.touches),
    ).toFixed(4) +
    "\n  his touches in a game he played  " +
    spearman(
      perGame.map((p) => rate(p.before)), perGame.map((p) => rate(p.after)),
    ).toFixed(4) +
    "\n  the games he played              " +
    spearman(
      perGame.map((p) => p.before.games), perGame.map((p) => p.after.games),
    ).toFixed(4) +
    `\n  on ${perGame.length} men`,
  );

  /**
   * His season total already is his rate times his games, so putting
   * those back together says nothing. The question is what to expect of
   * his games, given they only carry at .37: his own, the league's, or
   * something between.
   */
  const truth = perGame.map((p) => p.after.touches);
  const leagueGames = middle(perGame.map((p) => p.before.games));

  console.log("\nguessing next season's touches");
  console.log("  how much of his own games we keep   spearman");

  for (const keep of [0, 0.25, 0.5, 0.75, 1]) {
    const guess = perGame.map((p) =>
      rate(p.before) * (keep * p.before.games + (1 - keep) * leagueGames));
    console.log(
      `    ${(100 * keep).toFixed(0)}%`.padEnd(38) +
      spearman(guess, truth).toFixed(4),
    );
  }

  // the ground they play on
  const surface = new Map<string, string>();

  for (const game of await loadGames()) {
    if (game.season < 2022) continue;
    surface.set(`${game.season}|${game.week}|${game.homeTeamId}`, game.surface ?? "");
    surface.set(`${game.season}|${game.week}|${game.awayTeamId}`, game.surface ?? "");
  }

  const hurtOn = new Map<string, { hurt: number; games: number }>();

  for (const season of [2022, 2023, 2024, 2025]) {
    const rows = parseCsv(
      await readFile(join(RAW_DIR, `injuries_${season}.csv`), "utf8"),
    ).filter((r) => ["RB", "WR", "TE"].includes(r["position"] ?? ""));

    for (const row of rows) {
      const key = `${season}|${row["week"]}|${row["team"]}`;
      const ground = (surface.get(key) ?? "").replace(/"/g, "");

      if (!ground) {
        continue;
      }

      const kind = ground === "grass" ? "grass" : "turf";
      const tally = hurtOn.get(kind) ?? { hurt: 0, games: 0 };
      tally.games++;
      if ((row["report_status"] ?? "") === "Out") tally.hurt++;
      hurtOn.set(kind, tally);
    }
  }

  console.log("\nmen on the injury list who were ruled out, by ground");

  for (const [kind, tally] of hurtOn) {
    console.log(
      "  " + kind.padEnd(8) + (100 * tally.hurt / tally.games).toFixed(1) +
      "%   of " + tally.games + " listings",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

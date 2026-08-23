/**
 * Does the weather move an offence, once you take the side out of it?
 *
 * Cold games are late in the year, in particular stadiums, played by
 * the sides that own those stadiums, so a raw split between cold and
 * mild is mostly a split between Buffalo and Miami. Every comparison
 * here is inside one side's own season: its cold afternoons against its
 * own mild ones, so the side, its coach and its quarterback are held
 * still and only the day changes.
 *
 * Run: npx tsx scripts/weatherOffenceCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";

const FROM = 2015;
const TO = 2025;
const COLD = 40;
const WARM = 60;
const WINDY = 12;

interface Side {
  team: string;
  season: number;
  week: number;
  points: number;
  indoors: boolean;
  temperature?: number;
  wind?: number;
  passYds: number;
  rushYds: number;
  passAttempts: number;
  rushAttempts: number;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/**
 * What a side did on its cold days against its own mild ones, averaged
 * over every side that had some of each.
 */
function withinSide(
  sides: Side[],
  pick: (s: Side) => boolean,
  against: (s: Side) => boolean,
  of: (s: Side) => number,
) {
  const bySide = new Map<string, Side[]>();

  for (const s of sides) {
    const key = s.team + "|" + s.season;
    bySide.set(key, [...(bySide.get(key) ?? []), s]);
  }

  const gaps: number[] = [];
  let games = 0;

  for (const its of bySide.values()) {
    const these = its.filter(pick);
    const those = its.filter(against);

    if (these.length < 1 || those.length < 3) {
      continue;
    }

    gaps.push(mean(these.map(of)) - mean(those.map(of)));
    games += these.length;
  }

  const middle = mean(gaps);
  const spread = Math.sqrt(
    gaps.reduce((s, g) => s + (g - middle) ** 2, 0) / Math.max(1, gaps.length - 1),
  );

  return {
    gap: middle,
    sides: gaps.length,
    games,
    // how far the average could be off by chance, which decides whether
    // any of this is worth modelling
    error: spread / Math.sqrt(Math.max(1, gaps.length)),
  };
}

async function main(): Promise<void> {
  const fixtures = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8",
  ));
  const sides: Side[] = [];
  const byGame = new Map<string, { passYds: number; rushYds: number; pa: number; ra: number }>();

  for (let season = FROM; season <= TO; season++) {
    for (const w of await loadPlayerStats(season).catch(() => [])) {
      if (w.week > 18) {
        continue;
      }

      const key = `${season}|${w.week}|${w.teamId}`;
      const seen = byGame.get(key) ?? { passYds: 0, rushYds: 0, pa: 0, ra: 0 };
      const line = w.statLine as unknown as Record<string, number>;
      seen.passYds += line["passYds"] ?? 0;
      seen.rushYds += line["rushYds"] ?? 0;
      seen.pa += w.passing?.attempts ?? 0;
      seen.ra += w.carries ?? 0;
      byGame.set(key, seen);
    }
  }

  for (const r of fixtures) {
    const season = Number(r["season"]);

    if (!(season >= FROM && season <= TO) || r["game_type"] !== "REG") {
      continue;
    }

    const week = Number(r["week"]);
    const roof = r["roof"] ?? "";
    const indoors = roof === "dome" || roof === "closed";
    // a nought is nobody writing it down, not a freezing afternoon in
    // Miami, and there are 430 of them
    const said = Number(r["temp"]);
    const temp = r["temp"] && r["temp"] !== "NA" && said !== 0 ? said : undefined;
    const wind = r["wind"] && r["wind"] !== "NA" ? Number(r["wind"]) : undefined;

    for (const [team, points] of [
      [r["home_team"], Number(r["home_score"])],
      [r["away_team"], Number(r["away_score"])],
    ] as [string, number][]) {
      if (!team || !Number.isFinite(points)) {
        continue;
      }

      const its = byGame.get(`${season}|${week}|${team}`);
      sides.push({
        team, season, week, points, indoors,
        temperature: temp, wind,
        passYds: its?.passYds ?? 0, rushYds: its?.rushYds ?? 0,
        passAttempts: its?.pa ?? 0, rushAttempts: its?.ra ?? 0,
      });
    }
  }

  const outdoors = sides.filter((s) => !s.indoors && s.temperature !== undefined);
  console.log(`${sides.length} team-games, ${outdoors.length} outdoors with a reading`);

  const cold = (s: Side) => (s.temperature ?? 60) < COLD;
  const mild = (s: Side) => (s.temperature ?? 60) >= WARM;
  const blowing = (s: Side) => (s.wind ?? 0) >= WINDY;
  const still = (s: Side) => (s.wind ?? 0) < 5;

  const show = (what: string, of: (s: Side) => number, places = 2) => {
    const c = withinSide(outdoors, cold, mild, of);
    const w = withinSide(outdoors, blowing, still, of);
    const say = (r: { gap: number; error: number }) =>
      ((r.gap >= 0 ? "+" : "") + r.gap.toFixed(places)).padStart(8) +
      (" +/-" + r.error.toFixed(places)).padStart(9) +
      (Math.abs(r.gap) > 2 * r.error ? "  yes" : "   no");
    console.log("  " + what.padEnd(22) + say(c) + "   " + say(w));
  };

  console.log("\nagainst the same side's own mild, still afternoons");
  console.log("                           under 40F      error  real       windy      error  real");
  show("points scored", (s) => s.points);
  show("passing yards", (s) => s.passYds, 1);
  show("rushing yards", (s) => s.rushYds, 1);
  show("pass attempts", (s) => s.passAttempts);
  show("rush attempts", (s) => s.rushAttempts);
  show("yards a pass", (s) => (s.passAttempts > 0 ? s.passYds / s.passAttempts : 0));
  show("yards a carry", (s) => (s.rushAttempts > 0 ? s.rushYds / s.rushAttempts : 0));
  show("share of plays thrown",
    (s) => (s.passAttempts + s.rushAttempts > 0
      ? s.passAttempts / (s.passAttempts + s.rushAttempts) : 0), 3);

  /**
   * And the roof, which belongs to the ground rather than the day, so a
   * side cannot be held against itself. The visiting side can: it plays
   * some of its away games indoors and some in the open.
   */
  const away = new Map<string, { inside: number[]; outside: number[] }>();

  for (const r of fixtures) {
    const season = Number(r["season"]);

    if (!(season >= FROM && season <= TO) || r["game_type"] !== "REG") {
      continue;
    }

    const roof = r["roof"] ?? "";
    const indoors = roof === "dome" || roof === "closed";
    const team = r["away_team"] ?? "";
    const points = Number(r["away_score"]);

    if (!team || !Number.isFinite(points)) {
      continue;
    }

    const key = team + "|" + season;
    const seen = away.get(key) ?? { inside: [], outside: [] };
    (indoors ? seen.inside : seen.outside).push(points);
    away.set(key, seen);
  }

  const roofGaps: number[] = [];

  for (const its of away.values()) {
    if (its.inside.length >= 2 && its.outside.length >= 4) {
      roofGaps.push(mean(its.inside) - mean(its.outside));
    }
  }

  console.log(
    "\n  a side away, indoors against its own away games in the open: " +
    (mean(roofGaps) >= 0 ? "+" : "") + mean(roofGaps).toFixed(2) +
    " points, over " + roofGaps.length + " sides",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

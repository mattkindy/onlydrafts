/**
 * Is there a point past which a workload starts costing something?
 *
 * A straight correlation says heavy work goes with more games the next
 * season, not fewer, but that would hide a cliff at the top end: the
 * old claim is that a back who carries it enough times falls off the
 * year after. A trend over everybody cannot see a cliff, so this cuts
 * the top end finely and looks at what happened next.
 *
 * Run: npx tsx scripts/workloadThresholdEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;
const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Year {
  position: string;
  games: number;
  touches: number;
  carries: number;
  points: number;
}

async function seasonOf(season: number): Promise<Map<string, Year>> {
  const tally = new Map<string, Year>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    const own = tally.get(s.playerId) ??
      { position: s.position, games: 0, touches: 0, carries: 0, points: 0 };
    own.games++;
    own.touches += s.carries + s.targets;
    own.carries += s.carries;
    own.points += fantasyPoints(s.statLine, RULES);
    tally.set(s.playerId, own);
  }

  return tally;
}

async function main(): Promise<void> {
  const years = new Map<number, Map<string, Year>>();

  for (const season of SEASONS) {
    years.set(season, await seasonOf(season));
  }

  const pairs: { before: Year; after: Year }[] = [];

  for (const season of SEASONS.slice(1)) {
    const was = years.get(season - 1)!;
    const now = years.get(season)!;

    for (const [playerId, after] of now) {
      const before = was.get(playerId);
      if (before) pairs.push({ before, after });
    }
  }

  // men who missed the next season entirely are the ones a durability
  // question is about, so they have to be counted as nought games
  const everyone = new Map<string, Year>();

  for (const [, season] of years) {
    for (const [playerId, year] of season) {
      if (!everyone.has(playerId)) everyone.set(playerId, year);
    }
  }

  const vanished: { before: Year; after: Year }[] = [];

  for (const season of SEASONS.slice(0, -1)) {
    const was = years.get(season)!;
    const next = years.get(season + 1)!;

    for (const [playerId, before] of was) {
      if (!next.has(playerId)) {
        vanished.push({
          before,
          after: { position: before.position, games: 0, touches: 0, carries: 0, points: 0 },
        });
      }
    }
  }

  const all = [...pairs, ...vanished].filter((p) => p.before.position === "RB");
  console.log(
    `${all.length} back seasons with a season after them, ` +
      `${vanished.filter((v) => v.before.position === "RB").length} of which vanished\n`,
  );

  const bands: [string, number, number][] = [
    ["under 150", 0, 150],
    ["150 to 224", 150, 225],
    ["225 to 274", 225, 275],
    ["275 to 324", 275, 325],
    ["325 to 374", 325, 375],
    ["375 and up", 375, 10000],
  ];

  console.log("what a back did the next season, by his touches this one");
  console.log("  touches       games   points a game   played at all   men");

  for (const [label, low, high] of bands) {
    const at = all.filter((p) => p.before.touches >= low && p.before.touches < high);

    if (at.length < 8) {
      continue;
    }

    const played = at.filter((p) => p.after.games > 0);
    console.log(
      "  " + label.padEnd(14) +
      middle(at.map((p) => p.after.games)).toFixed(1).padStart(5) +
      middle(played.map((p) => p.after.points / p.after.games)).toFixed(1).padStart(14) +
      `${(100 * played.length / at.length).toFixed(0)}%`.padStart(14) +
      String(at.length).padStart(7),
    );
  }

  // the same again on carries alone, which is the form the old claim
  // was made in
  console.log("\nand by carries alone, which is how the claim was put");
  console.log("  carries       games   points a game   played at all   men");

  for (const [label, low, high] of [
    ["under 200", 0, 200], ["200 to 299", 200, 300],
    ["300 to 369", 300, 370], ["370 and up", 370, 10000],
  ] as [string, number, number][]) {
    const at = all.filter((p) => p.before.carries >= low && p.before.carries < high);

    if (at.length < 5) {
      continue;
    }

    const played = at.filter((p) => p.after.games > 0);
    console.log(
      "  " + label.padEnd(14) +
      middle(at.map((p) => p.after.games)).toFixed(1).padStart(5) +
      middle(played.map((p) => p.after.points / p.after.games)).toFixed(1).padStart(14) +
      `${(100 * played.length / at.length).toFixed(0)}%`.padStart(14) +
      String(at.length).padStart(7),
    );
  }

  // and what a man kept of his own rate, which asks whether the heavy
  // ones fell off relative to themselves rather than to everybody
  console.log("\nof his own points a game, what he kept the next season");

  for (const [label, low, high] of bands) {
    const at = all.filter((p) =>
      p.before.touches >= low && p.before.touches < high &&
      p.before.games >= 8 && p.after.games >= 4 && p.before.points > 0);

    if (at.length < 8) {
      continue;
    }

    console.log(
      "  " + label.padEnd(14) +
      (100 * middle(at.map((p) =>
        (p.after.points / p.after.games) / (p.before.points / p.before.games),
      ))).toFixed(0) + "%   on " + at.length + " men",
    );
  }

  await control(all);
}

/**
 * The control the bands above cannot give.
 *
 * Anyone at the top of a season comes down the next one, so a heavy
 * back losing ground says nothing on its own. Put him beside a man who
 * scored the same and was used less: if the heavy one falls further,
 * the work did it, and if they fall together, it was only the coming
 * down that everybody does.
 */
async function control(all: { before: Year; after: Year }[]): Promise<void> {
  const usable = all.filter((p) =>
    p.before.games >= 8 && p.after.games >= 4 && p.before.points > 0);
  const rate = (year: Year) => year.points / year.games;

  console.log("\nheavy and light backs who scored the same, and what they kept");
  console.log("  points a game before   heavy   light   men");

  for (const [label, low, high] of [
    ["8 to 12", 8, 12], ["12 to 16", 12, 16], ["16 and up", 16, 100],
  ] as [string, number, number][]) {
    const at = usable.filter((p) => rate(p.before) >= low && rate(p.before) < high);

    if (at.length < 16) {
      continue;
    }

    const byWork = [...at].sort((a, b) => b.before.touches - a.before.touches);
    const half = Math.floor(byWork.length / 2);
    const heavy = byWork.slice(0, half);
    const light = byWork.slice(byWork.length - half);
    const kept = (set: typeof at) =>
      100 * middle(set.map((p) => rate(p.after) / rate(p.before)));

    console.log(
      "  " + label.padEnd(23) + kept(heavy).toFixed(0) + "%" +
      kept(light).toFixed(0).padStart(8) + "%" +
      String(at.length).padStart(6) +
      `   (heavy averaged ${middle(heavy.map((p) => p.before.touches)).toFixed(0)}` +
      ` touches, light ${middle(light.map((p) => p.before.touches)).toFixed(0)})`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Where adp is wrong in a way that repeats.
 *
 * Beating it on the whole board is one thing, and small. Finding a kind
 * of player it misprices the same way every year is worth more, because
 * that is something to act on rather than a decimal.
 *
 * For every man it put a price on, this compares where he went with
 * where he finished, and then asks whether the gap lines up with
 * anything knowable in August.
 *
 * Run: npx tsx scripts/mispriceEval.ts
 */

import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { loadAdp } from "../src/data/adp.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { normalizeName } from "../src/data/names.js";

const RULES = presets.standard;
const SEASONS = [2022, 2023, 2024, 2025];

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface Priced {
  season: number;
  name: string;
  position: string;
  adp: number;
  points: number;
  /** where he went and where he finished, as places */
  went: number;
  finished: number;
  experience: number;
  rookie: boolean;
  lastSeason: number | null;
  moved: boolean;
}

async function main(): Promise<void> {
  const picks = await loadDraftPicks();
  const all: Priced[] = [];

  for (const season of SEASONS) {
    const adp = await loadAdp(season, "ppr").catch(() => new Map());

    if (!adp.size) {
      continue;
    }

    const totals = new Map<string, { name: string; position: string; points: number; team: string }>();

    for (const s of await loadPlayerStats(season)) {
      if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
      const own = totals.get(s.playerId) ??
        { name: s.playerName, position: s.position, points: 0, team: s.teamId };
      own.points += fantasyPoints(s.statLine, RULES);
      own.team = s.teamId;
      totals.set(s.playerId, own);
    }

    const wasOn = new Map<string, string>();
    const wasPoints = new Map<string, number>();

    for (const s of await loadPlayerStats(season - 1)) {
      if (s.week > 18) continue;
      wasOn.set(s.playerId, s.teamId);
      wasPoints.set(
        s.playerId, (wasPoints.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
      );
    }

    const experience = new Map<string, number>();

    for (const row of await loadWeeklyRosters(season)) {
      if (row.yearsExperience !== undefined) {
        experience.set(row.playerId, row.yearsExperience);
      }
    }

    /**
     * Built from adp's list, not from the men who played.
     *
     * Taking only players with a stat line drops everybody adp
     * drafted who never took a snap, and those are late picks almost to
     * a man. That alone would make late picks look like bargains.
     */
    const byName = new Map<string, { playerId: string; own: typeof totals extends Map<string, infer V> ? V : never }>();

    for (const [playerId, own] of totals) {
      byName.set(`${normalizeName(own.name)}|${own.position}`, { playerId, own });
    }

    const priced: Priced[] = [];
    let never = 0;

    for (const [key, entry] of adp) {
      if (!["RB", "WR", "TE"].includes(entry.position)) {
        continue;
      }

      const played = byName.get(key);

      if (!played) {
        never++;
      }

      const playerId = played?.playerId ?? "";
      const pick = picks.get(playerId);
      priced.push({
        season, name: entry.name, position: entry.position, adp: entry.adp,
        points: played?.own.points ?? 0, went: 0, finished: 0,
        experience: experience.get(playerId) ?? 3,
        rookie: pick !== undefined && pick.season === season,
        lastSeason: wasPoints.get(playerId) ?? null,
        moved: played !== undefined && wasOn.has(playerId) &&
          wasOn.get(playerId) !== played.own.team,
      });
    }

    console.log(
      `${season}: ${priced.length} priced, ${never} of whom never took a snap`,
    );

    const byAdp = [...priced].sort((a, b) => a.adp - b.adp);
    byAdp.forEach((man, at) => { man.went = at + 1; });
    const byPoints = [...priced].sort((a, b) => b.points - a.points);
    byPoints.forEach((man, at) => { man.finished = at + 1; });
    all.push(...priced);
  }

  console.log(`${all.length} priced men over ${SEASONS.join(", ")}\n`);

  // a positive gap means he finished better than he went
  const gap = (man: Priced) => man.went - man.finished;

  const report = (label: string, set: Priced[]) => {
    if (set.length < 15) {
      return;
    }

    const mid = middle(set.map(gap));
    const spread = Math.sqrt(
      middle(set.map((m) => (gap(m) - mid) ** 2)) / set.length,
    );
    console.log(
      "  " + label.padEnd(30) +
      (mid >= 0 ? "+" : "") + mid.toFixed(1).padStart(6) +
      ` give or take ${spread.toFixed(1)}`.padEnd(22) +
      String(set.length).padStart(5),
    );
  };

  /**
   * Within a band of the board, so the comparison is between men the
   * adp priced alike.
   *
   * A gap of places gained cannot be read straight. A man taken third
   * can only fall and one taken 150th can only climb, so any noisy
   * order shows early picks losing and late picks gaining whether the
   * adp is wrong or not. Holding the band fixed takes that out.
   */
  const bands: [string, (m: Priced) => boolean][] = [
    ["early", (m) => m.adp <= 48],
    ["middle", (m) => m.adp > 48 && m.adp <= 108],
    ["late", (m) => m.adp > 108],
  ];

  const withinBands = (label: string, keep: (m: Priced) => boolean) => {
    const parts: string[] = [];

    for (const [band, inBand] of bands) {
      const set = all.filter((m) => inBand(m) && keep(m));
      const rest = all.filter((m) => inBand(m) && !keep(m));

      if (set.length < 12 || rest.length < 12) {
        parts.push(`${band} -`);
        continue;
      }

      const gapHere = middle(set.map(gap)) - middle(rest.map(gap));
      const spread = Math.sqrt(
        middle(set.map((m) => (gap(m) - middle(set.map(gap))) ** 2)) / set.length +
        middle(rest.map((m) => (gap(m) - middle(rest.map(gap))) ** 2)) / rest.length,
      );
      parts.push(
        `${band} ${gapHere >= 0 ? "+" : ""}${gapHere.toFixed(0)}` +
        `±${spread.toFixed(0)} (${set.length})`,
      );
    }

    console.log("  " + label.padEnd(24) + parts.join("   "));
  };

  console.log(
    "against other men adp priced alike, places gained\n",
  );

  for (const position of ["RB", "TE"]) {
    withinBands(position + " against the rest", (m) => m.position === position);
  }

  withinBands("rookies", (m) => m.rookie);
  withinBands("changed teams", (m) => m.moved && !m.rookie);
  withinBands("seven years and up", (m) => m.experience >= 7);

  console.log("\nand the same without holding the band, which cannot be read");
  console.log("places gained on where adp had him, by kind of player");
  console.log("  kind                            gap                        men");

  for (const position of ["RB", "WR", "TE"]) {
    report(position, all.filter((m) => m.position === position));
  }

  console.log();
  report("rookies", all.filter((m) => m.rookie));
  report("men who changed teams", all.filter((m) => m.moved && !m.rookie));
  report("men who stayed", all.filter((m) => !m.moved && !m.rookie));

  console.log();
  report("first or second year", all.filter((m) => m.experience <= 2 && !m.rookie));
  report("three to six years", all.filter((m) => m.experience >= 3 && m.experience <= 6));
  report("seven years and up", all.filter((m) => m.experience >= 7));

  console.log();

  for (const [label, keep] of [
    ["taken in the first three rounds", (m: Priced) => m.adp <= 36],
    ["rounds four to eight", (m: Priced) => m.adp > 36 && m.adp <= 96],
    ["after pick 96", (m: Priced) => m.adp > 96],
  ] as [string, (m: Priced) => boolean][]) {
    report(label, all.filter(keep));
  }

  // and whether last season's points, which adp can see, are
  // still worth something after adp has priced him
  const withLast = all.filter((m) => m.lastSeason !== null);
  console.log(
    `\nafter adp has spoken, does last season still say anything` +
      `\n  ${withLast.length} men: ` +
      spearman(
        withLast.map((m) => m.lastSeason!), withLast.map((m) => -m.finished),
      ).toFixed(4) + " for last season against where he finished" +
      "\n  and against the gap he left: " +
      spearman(withLast.map((m) => m.lastSeason!), withLast.map(gap)).toFixed(4) +
      ` give or take ${noise(withLast.length).toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

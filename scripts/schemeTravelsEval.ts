/**
 * Does a coordinator's scheme go with him?
 *
 * Coach effects measured as almost nothing all day, but every one of
 * those tests looked at player shares, which sit three steps
 * downstream of anything a coach decides. What he decides directly is
 * how often to line up in eleven personnel and how often to go under
 * centre, and that is what this measures.
 *
 * Run: npx tsx scripts/schemeTravelsEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { loadCoaches } from "../src/data/coaches.js";
import { spearman } from "../src/backtest/metrics.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2022, 2023, 2024, 2025];

interface Scheme {
  plays: number;
  elevenPersonnel: number;
  heavy: number;
  shotgun: number;
  underCentre: number;
}

async function schemeOf(season: number): Promise<Map<string, Scheme>> {
  const path = join(RAW_DIR, `participation_${season}.csv`);
  const byTeam = new Map<string, Scheme>();

  if (!existsSync(path)) {
    return byTeam;
  }

  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  let iTeam = -1, iPersonnel = -1, iFormation = -1;

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      iTeam = header.indexOf("possession_team");
      iPersonnel = header.indexOf("offense_personnel");
      iFormation = header.indexOf("offense_formation");
      continue;
    }

    const cells = splitLine(line);
    const team = cells[iTeam] ?? "";
    const personnel = cells[iPersonnel] ?? "";
    const formation = cells[iFormation] ?? "";

    if (!team || !personnel || personnel === "NA") {
      continue;
    }

    const backs = Number(/(\d+) RB/.exec(personnel)?.[1] ?? NaN);
    const tightEnds = Number(/(\d+) TE/.exec(personnel)?.[1] ?? NaN);

    if (!Number.isFinite(backs) || !Number.isFinite(tightEnds)) {
      continue;
    }

    const scheme = byTeam.get(team) ??
      { plays: 0, elevenPersonnel: 0, heavy: 0, shotgun: 0, underCentre: 0 };
    scheme.plays++;
    if (backs === 1 && tightEnds === 1) scheme.elevenPersonnel++;
    if (backs + tightEnds >= 3) scheme.heavy++;
    if (formation === "SHOTGUN") scheme.shotgun++;
    if (formation === "UNDER CENTER") scheme.underCentre++;
    byTeam.set(team, scheme);
  }

  return byTeam;
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const schemes = new Map<number, Map<string, Scheme>>();

  for (const season of SEASONS) {
    schemes.set(season, await schemeOf(season));
    console.log(`${season}: ${schemes.get(season)!.size} offences`);
  }

  interface Pair { kept: boolean; before: Scheme; after: Scheme }
  const pairs: Pair[] = [];

  for (const season of SEASONS.slice(1)) {
    for (const [team, after] of schemes.get(season) ?? []) {
      const before = schemes.get(season - 1)?.get(team);
      if (!before || before.plays < 400 || after.plays < 400) continue;
      const now = coaches.get(`${team}|${season}|OC`) ?? "";
      const then = coaches.get(`${team}|${season - 1}|OC`) ?? "";
      if (!now || !then) continue;
      pairs.push({ kept: now === then, before, after });
    }
  }

  const kept = pairs.filter((p) => p.kept);
  const changed = pairs.filter((p) => !p.kept);

  console.log(`\n${pairs.length} team-season pairs, ${kept.length} kept the play-caller, ${changed.length} did not\n`);
  console.log("what the offence lines up in     same man   new man   the coach's share");

  for (const [label, get] of [
    ["eleven personnel", (s: Scheme) => s.elevenPersonnel / s.plays],
    ["heavy personnel", (s: Scheme) => s.heavy / s.plays],
    ["shotgun", (s: Scheme) => s.shotgun / s.plays],
    ["under centre", (s: Scheme) => s.underCentre / s.plays],
  ] as [string, (s: Scheme) => number][]) {
    const score = (list: Pair[]) =>
      list.length >= 15
        ? spearman(list.map((p) => get(p.before)), list.map((p) => get(p.after)))
        : NaN;
    const a = score(kept);
    const b = score(changed);
    console.log(
      label.padEnd(33) + a.toFixed(3).padStart(8) + b.toFixed(3).padStart(10) +
      (a - b).toFixed(3).padStart(20),
    );
  }

  console.log("\nfor comparison, measured earlier on player shares:");
  console.log("  a back's carry share             0.264    -0.054               0.319");
  console.log("  a top receiver's target share    0.182     0.136               0.046");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

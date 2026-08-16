/**
 * Fits every player's effect on pressure from who was on the field,
 * then asks the question that matters: when a man changes team, does
 * his number go with him?
 *
 * If it does, a line is its five current men rather than a franchise,
 * and a signing or a return from injury changes what the offence is
 * without anyone writing a rule about it.
 *
 * Run: npx tsx scripts/participationRapm.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { fitPlusMinus, type Snap } from "../src/model/plusMinus.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASONS = [2022, 2023, 2024, 2025];
const BLOCKERS = new Set(["T", "G", "C", "TE", "QB", "RB", "FB"]);
const RUSHERS = new Set(["DE", "DT", "NT", "OLB", "ILB", "LB", "MLB"]);

function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else cell += ch;
  }

  cells.push(cell);
  return cells;
}

interface Loaded {
  snaps: Snap[];
  team: Map<string, string>;
}

async function loadSeason(season: number): Promise<Loaded> {
  const path = join(RAW_DIR, `participation_${season}.csv`);
  const snaps: Snap[] = [];
  const team = new Map<string, string>();

  if (!existsSync(path)) {
    return { snaps, team };
  }

  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  let iOff = -1, iDef = -1, iOffPos = -1, iDefPos = -1, iPressure = -1, iPoss = -1, iGame = -1;

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      iOff = header.indexOf("offense_players");
      iDef = header.indexOf("defense_players");
      iOffPos = header.indexOf("offense_positions");
      iDefPos = header.indexOf("defense_positions");
      iPressure = header.indexOf("was_pressure");
      iPoss = header.indexOf("possession_team");
      iGame = header.indexOf("nflverse_game_id");
      continue;
    }

    const cells = splitLine(line);
    const pressure = cells[iPressure];

    if (pressure !== "TRUE" && pressure !== "FALSE") {
      continue;
    }

    const offIds = (cells[iOff] ?? "").split(";").filter(Boolean);
    const defIds = (cells[iDef] ?? "").split(";").filter(Boolean);
    const offPos = (cells[iOffPos] ?? "").split(";");
    const defPos = (cells[iDefPos] ?? "").split(";");

    if (offIds.length !== offPos.length || defIds.length !== defPos.length) {
      continue;
    }

    const offense = cells[iPoss] ?? "";
    const parts = (cells[iGame] ?? "").split("_");
    const defense = parts.length >= 4 ? (parts[2] === offense ? parts[3]! : parts[2]!) : "";

    const blockers = offIds.filter((_, i) => BLOCKERS.has(offPos[i]!));
    const rushers = defIds.filter((_, i) => RUSHERS.has(defPos[i]!));

    if (blockers.length < 5 || rushers.length < 3) {
      continue;
    }

    for (const id of blockers) team.set(id, offense);
    for (const id of rushers) team.set(id, defense);

    // a blocker helps keep the quarterback clean, a rusher works against it
    snaps.push({
      forIt: blockers,
      against: rushers,
      outcome: pressure === "TRUE" ? 0 : 1,
    });
  }

  return { snaps, team };
}

async function main(): Promise<void> {
  const fits = new Map<number, ReturnType<typeof fitPlusMinus>>();
  const teams = new Map<number, Map<string, string>>();

  for (const season of SEASONS) {
    const { snaps, team } = await loadSeason(season);

    if (snaps.length === 0) {
      console.warn(`no snaps for ${season}`);
      continue;
    }

    console.log(`${season}: ${snaps.length} drop-backs, fitting...`);
    fits.set(season, fitPlusMinus(snaps, 600));
    teams.set(season, team);
  }

  console.log("\nkeeping the quarterback clean, per player, above average");
  console.log("(a blocker's number is how much cleaner he makes it)\n");

  const latest = fits.get(2025);
  const seenEnough = latest
    ? [...latest.effects].filter(([id]) => (latest.snaps.get(id) ?? 0) >= 300)
    : [];
  seenEnough.sort((a, b) => b[1] - a[1]);
  console.log("  best five  " + seenEnough.slice(0, 5).map(([, v]) => v.toFixed(3)).join("  "));
  console.log("  worst five " + seenEnough.slice(-5).map(([, v]) => v.toFixed(3)).join("  "));

  // the test the whole idea rests on
  console.log("\ndoes a man's number follow him?\n");
  console.log("group                              n    year over year");

  for (const season of SEASONS.slice(1)) {
    const before = fits.get(season - 1);
    const now = fits.get(season);
    const wasOn = teams.get(season - 1);
    const isOn = teams.get(season);

    if (!before || !now || !wasOn || !isOn) continue;

    const both: { id: string; a: number; b: number; moved: boolean }[] = [];

    for (const [id, value] of now.effects) {
      const previous = before.effects.get(id);
      if (previous === undefined) continue;
      if ((before.snaps.get(id) ?? 0) < 300 || (now.snaps.get(id) ?? 0) < 300) continue;
      both.push({ id, a: previous, b: value, moved: wasOn.get(id) !== isOn.get(id) });
    }

    const stayed = both.filter((x) => !x.moved);
    const moved = both.filter((x) => x.moved);
    const score = (list: typeof both) =>
      list.length >= 20
        ? spearman(list.map((x) => x.a), list.map((x) => x.b)).toFixed(3).padStart(14)
        : "too few".padStart(14);

    console.log(`  ${season - 1} to ${season}, stayed put`.padEnd(35) +
      String(stayed.length).padStart(4) + score(stayed));
    console.log(`  ${season - 1} to ${season}, changed team`.padEnd(35) +
      String(moved.length).padStart(4) + score(moved));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

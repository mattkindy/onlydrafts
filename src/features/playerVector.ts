/**
 * A description of a player, built from what can be looked up rather
 * than learned from scratch.
 *
 * Learning twelve free numbers per man needs far more plays than four
 * seasons give, which is why the fitted vectors came out level with
 * adding the pieces up. Starting from his height, his draft pick, what
 * he ran at the combine and how he has been used leaves the model only
 * the job of working out how descriptions combine.
 *
 * It also fixes the awkward cases: a rookie has a description on draft
 * day, a man takes his to a new team, and a team's is whatever its
 * current players add up to.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import { RAW_DIR, loadPlayerStats, loadWeeklyRosters } from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";

/** what each slot in the vector means, in order */
export const ATTRIBUTES = [
  "height", "weight", "age", "experience",
  "draftPick", "wentUndrafted",
  "speed", "explosion", "agility",
  "targetsPerGame", "carriesPerGame", "catchRate",
  "yardsPerCatch", "yardsPerCarry", "airYardsPerTarget",
  "scoresPerGame",
] as const;

export type Attribute = (typeof ATTRIBUTES)[number];

export interface PlayerVector {
  playerId: string;
  name: string;
  position: string;
  /** one number per attribute, centred and scaled across the league */
  values: Float64Array;
}

/** the middle of each attribute, so a missing one sits at nothing */
const MIDDLE: Record<Attribute, number> = {
  height: 73, weight: 210, age: 26, experience: 4,
  draftPick: 130, wentUndrafted: 0,
  speed: 4.55, explosion: 34, agility: 7.0,
  targetsPerGame: 3, carriesPerGame: 3, catchRate: 0.65,
  yardsPerCatch: 11, yardsPerCarry: 4.3, airYardsPerTarget: 8,
  scoresPerGame: 0.25,
};

/** and roughly how far apart players are on it */
const SPREAD: Record<Attribute, number> = {
  height: 3, weight: 30, age: 3, experience: 3,
  draftPick: 90, wentUndrafted: 1,
  speed: 0.15, explosion: 4, agility: 0.3,
  targetsPerGame: 2.5, carriesPerGame: 4, catchRate: 0.12,
  yardsPerCatch: 3, yardsPerCarry: 1.1, airYardsPerTarget: 3.5,
  scoresPerGame: 0.2,
};

const ageIn = (birth: string, season: number) => {
  const year = Number((birth ?? "").slice(0, 4));
  return Number.isFinite(year) && year > 1950 ? season - year : MIDDLE.age;
};

/**
 * The combine file is keyed by name and position rather than the id
 * everything else uses, so this join is on a normalised name and will
 * miss the odd man.
 */
async function combineByName(): Promise<Map<string, Record<string, string>>> {
  const text = await readFile(join(RAW_DIR, "combine.csv"), "utf8").catch(() => "");
  const out = new Map<string, Record<string, string>>();

  for (const row of text ? parseCsv(text) : []) {
    out.set(`${normalizeName(row["player_name"] ?? "")}|${row["pos"]}`, row);
  }

  return out;
}

interface Played {
  games: number; targets: number; carries: number; receptions: number;
  recYds: number; rushYds: number; airYards: number; scores: number;
}

export async function buildPlayerVectors(
  season: number,
  weeks = 18,
): Promise<Map<string, PlayerVector>> {
  const combine = await combineByName();
  const rosters = await loadWeeklyRosters(season);
  const played = new Map<string, Played>();

  for (const row of await loadPlayerStats(season)) {
    if (row.week > weeks) {
      continue;
    }

    const own = played.get(row.playerId) ?? {
      games: 0, targets: 0, carries: 0, receptions: 0,
      recYds: 0, rushYds: 0, airYards: 0, scores: 0,
    };
    own.games++;
    own.targets += row.targets;
    own.carries += row.carries;
    own.airYards += row.airYards;
    own.receptions += row.statLine.receptions ?? 0;
    own.recYds += row.statLine.recYds ?? 0;
    own.rushYds += row.statLine.rushYds ?? 0;
    own.scores += (row.statLine.recTd ?? 0) + (row.statLine.rushTd ?? 0);
    played.set(row.playerId, own);
  }

  const out = new Map<string, PlayerVector>();

  for (const row of rosters) {
    const id = row.playerId;

    if (!id || out.has(id)) {
      continue;
    }

    const own = played.get(id);
    const measured = combine.get(
      `${normalizeName(row.name)}|${row.rawPosition}`,
    );
    const pick = row.draftOverall;
    const per = (get: (s: Played) => number) =>
      own && own.games > 0 ? get(own) / own.games : undefined;

    const found: Record<Attribute, number | undefined> = {
      height: row.heightInches,
      weight: row.weightPounds,
      age: ageIn(row.birthDate ?? "", season),
      experience: row.yearsExperience,
      draftPick: pick && pick > 0 ? pick : 260,
      wentUndrafted: pick && pick > 0 ? 0 : 1,
      speed: Number(measured?.["forty"]) || undefined,
      explosion: Number(measured?.["vertical"]) || undefined,
      agility: Number(measured?.["cone"]) || undefined,
      targetsPerGame: per((s) => s.targets),
      carriesPerGame: per((s) => s.carries),
      catchRate: own && own.targets > 0 ? own.receptions / own.targets : undefined,
      yardsPerCatch: own && own.receptions > 0 ? own.recYds / own.receptions : undefined,
      yardsPerCarry: own && own.carries > 0 ? own.rushYds / own.carries : undefined,
      airYardsPerTarget: own && own.targets > 0 ? own.airYards / own.targets : undefined,
      scoresPerGame: per((s) => s.scores),
    };

    const values = new Float64Array(ATTRIBUTES.length);

    ATTRIBUTES.forEach((attribute, i) => {
      const value = found[attribute];
      // a missing attribute sits where the middle of the league sits,
      // which is nothing once everything is centred
      values[i] = value === undefined || !Number.isFinite(value)
        ? 0
        : (value - MIDDLE[attribute]) / SPREAD[attribute];
    });

    out.set(id, {
      playerId: id, name: row.name, position: row.rawPosition, values,
    });
  }

  return out;
}

/**
 * What a group of players adds up to. A team, or the eleven on the
 * field, gets its description this way rather than having one fitted:
 * it is whoever is there.
 */
export function poolVectors(
  vectors: PlayerVector[],
  weights?: number[],
): Float64Array {
  const pooled = new Float64Array(ATTRIBUTES.length);
  const total = weights ? weights.reduce((sum, w) => sum + w, 0) : vectors.length;

  if (total <= 0) {
    return pooled;
  }

  vectors.forEach((vector, index) => {
    const weight = weights ? weights[index]! : 1;

    for (let i = 0; i < ATTRIBUTES.length; i++) {
      pooled[i] = pooled[i]! + vector.values[i]! * weight;
    }
  });

  for (let i = 0; i < ATTRIBUTES.length; i++) {
    pooled[i] = pooled[i]! / total;
  }

  return pooled;
}

/** how alike two descriptions are, for finding a man's nearest match */
export function similarity(a: Float64Array, b: Float64Array): number {
  let dot = 0, left = 0, right = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }

  return left > 0 && right > 0 ? dot / Math.sqrt(left * right) : 0;
}

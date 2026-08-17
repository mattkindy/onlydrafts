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
  // what he is
  "height", "weight", "age", "experience",
  "draftPick", "wentUndrafted",
  "speed", "explosion", "agility", "power", "burst",
  // what his offence asks of him
  "targetShare", "airYardsShare", "carriesPerGame",
  "catchRate", "yardsPerCatch", "airYardsPerTarget", "yardsAfterCatch",
  "yardsPerCarry", "scoresPerGame",
  // and what he does when he throws it
  "passAttempts", "completionRate", "yardsPerAttempt", "passDepth", "sackRate",
  // or when the other team has it
  "tackles", "sacks", "quarterbackHits", "ballsDefended", "takeaways",
  // and what he does with a foot, or on a return
  "kickAccuracy", "legStrength", "longRange", "returnYards",
] as const;

export type Attribute = (typeof ATTRIBUTES)[number];

export interface PlayerVector {
  playerId: string;
  name: string;
  position: string;
  /** one number per attribute, centred and scaled across the league */
  values: Float64Array;
}

/**
 * Starting points only. The real middle and spread of each attribute
 * are measured from the players in front of us, per position group,
 * because a receiver's share of his team's targets and a back's are
 * different distributions and comparing them on one scale flatters
 * whichever has the wider one. These are what a group too small to
 * measure falls back to.
 */
const MIDDLE: Record<Attribute, number> = {
  height: 73, weight: 210, age: 26, experience: 4,
  draftPick: 130, wentUndrafted: 0,
  speed: 4.55, explosion: 34, agility: 7.0, power: 20, burst: 118,
  targetShare: 0.12, airYardsShare: 0.12, carriesPerGame: 3,
  catchRate: 0.65, yardsPerCatch: 11, airYardsPerTarget: 8, yardsAfterCatch: 4.4,
  yardsPerCarry: 4.3, scoresPerGame: 0.25,
  passAttempts: 32, completionRate: 0.65, yardsPerAttempt: 7.1,
  passDepth: 7.6, sackRate: 0.065,
  tackles: 3.5, sacks: 0.25, quarterbackHits: 0.35,
  ballsDefended: 0.35, takeaways: 0.06,
  kickAccuracy: 0.84, legStrength: 52, longRange: 0.66, returnYards: 18,
};

/** and roughly how far apart players are on it */
const SPREAD: Record<Attribute, number> = {
  height: 3, weight: 30, age: 3, experience: 3,
  draftPick: 90, wentUndrafted: 1,
  speed: 0.15, explosion: 4, agility: 0.3, power: 6, burst: 8,
  targetShare: 0.07, airYardsShare: 0.08, carriesPerGame: 4,
  catchRate: 0.12, yardsPerCatch: 3, airYardsPerTarget: 3.5, yardsAfterCatch: 2.2,
  yardsPerCarry: 1.1, scoresPerGame: 0.2,
  passAttempts: 10, completionRate: 0.06, yardsPerAttempt: 1.1,
  passDepth: 1.2, sackRate: 0.025,
  tackles: 2.2, sacks: 0.3, quarterbackHits: 0.4,
  ballsDefended: 0.35, takeaways: 0.07,
  kickAccuracy: 0.07, legStrength: 5, longRange: 0.2, returnYards: 14,
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
  recYds: number; rushYds: number; airYards: number; afterCatch: number;
  scores: number; targetShare: number; airYardsShare: number;
  attempts: number; completions: number; passYds: number;
  passAir: number; sacked: number;
  kicks: number; kicksMade: number; longest: number;
  longKicks: number; longMade: number; returnYards: number;
  tackles: number; sacks: number; hits: number; defended: number; takeaways: number;
}

/** which players share a scale, since their attributes have one shape */
function scaleGroup(position: string): string {
  if (position === "QB") return "QB";
  if (["K", "P"].includes(position)) return "kicking";
  if (["DB", "DL", "LB"].includes(position)) return "defence";
  if (["RB", "WR", "TE"].includes(position)) return "skill";
  return "other";
}

/** the middle and the spread of what was actually seen */
function measureScale(
  found: { group: string; values: (number | undefined)[] }[],
): Map<string, { middle: number[]; spread: number[] }> {
  const out = new Map<string, { middle: number[]; spread: number[] }>();

  for (const group of new Set(found.map((f) => f.group))) {
    const middle = new Array(ATTRIBUTES.length).fill(0);
    const spread = new Array(ATTRIBUTES.length).fill(1);

    ATTRIBUTES.forEach((attribute, i) => {
      const seen = found
        .filter((f) => f.group === group)
        .map((f) => f.values[i])
        .filter((v): v is number => v !== undefined && Number.isFinite(v));

      // too few to measure, so fall back to what was typed
      if (seen.length < 30) {
        middle[i] = MIDDLE[attribute];
        spread[i] = SPREAD[attribute];
        return;
      }

      const centre = seen.reduce((a, b) => a + b, 0) / seen.length;
      const width = Math.sqrt(
        seen.reduce((a, b) => a + (b - centre) ** 2, 0) / seen.length,
      );
      middle[i] = centre;
      spread[i] = width > 1e-6 ? width : SPREAD[attribute];
    });

    out.set(group, { middle, spread });
  }

  return out;
}

export async function buildPlayerVectors(
  season: number,
  weeks = 18,
): Promise<Map<string, PlayerVector>> {
  const rows = (await loadPlayerStats(season)).filter((r) => r.week <= weeks);

  return vectorsFrom(season, rows);
}

/**
 * The same description, from a man's last so many games rather than
 * from a season.
 *
 * A season boundary is nothing to a player. Taking the games behind
 * him, across seasons where it has to, means the description is right
 * in week six as well as in August, and a fit from it to what happens
 * next never sees the games it is being asked about.
 */
export async function buildRollingVectors(
  upTo: { season: number; week: number },
  games = 17,
): Promise<Map<string, PlayerVector>> {
  const seasons = [upTo.season - 2, upTo.season - 1, upTo.season];
  const every: Awaited<ReturnType<typeof loadPlayerStats>> = [];

  for (const season of seasons) {
    const rows = await loadPlayerStats(season).catch(() => []);

    for (const row of rows) {
      if (season < upTo.season || row.week < upTo.week) {
        every.push({ ...row, season });
      }
    }
  }

  // newest first, then each man's last so many
  every.sort((a, b) => b.season - a.season || b.week - a.week);
  const seen = new Map<string, number>();
  const kept: typeof every = [];

  for (const row of every) {
    const already = seen.get(row.playerId) ?? 0;

    if (already >= games) {
      continue;
    }

    seen.set(row.playerId, already + 1);
    kept.push(row);
  }

  return vectorsFrom(upTo.season, kept);
}

async function vectorsFrom(
  season: number,
  rows: Awaited<ReturnType<typeof loadPlayerStats>>,
): Promise<Map<string, PlayerVector>> {
  const combine = await combineByName();
  const rosters = await loadWeeklyRosters(season);
  const played = new Map<string, Played>();

  for (const row of rows) {
    const own = played.get(row.playerId) ?? {
      games: 0, targets: 0, carries: 0, receptions: 0,
      recYds: 0, rushYds: 0, airYards: 0, afterCatch: 0, scores: 0,
      targetShare: 0, airYardsShare: 0,
      attempts: 0, completions: 0, passYds: 0, passAir: 0, sacked: 0,
      kicks: 0, kicksMade: 0, longest: 0, longKicks: 0, longMade: 0,
      returnYards: 0,
      tackles: 0, sacks: 0, hits: 0, defended: 0, takeaways: 0,
    };
    own.games++;
    own.targets += row.targets;
    own.carries += row.carries;
    own.airYards += row.airYards;
    own.afterCatch += row.yardsAfterCatch;
    own.targetShare += row.targetShare;
    own.airYardsShare += row.airYardsShare;
    own.receptions += row.statLine.receptions ?? 0;
    own.recYds += row.statLine.recYds ?? 0;
    own.rushYds += row.statLine.rushYds ?? 0;
    own.scores += (row.statLine.recTd ?? 0) + (row.statLine.rushTd ?? 0);
    own.attempts += row.passing.attempts;
    own.completions += row.passing.completions;
    own.passYds += row.statLine.passYds ?? 0;
    own.passAir += row.passing.airYards;
    own.sacked += row.passing.sacksTaken;
    own.kicks += row.kicking.attempts;
    own.kicksMade += row.kicking.made;
    own.longest = Math.max(own.longest, row.kicking.longest);
    own.longKicks += row.kicking.longAttempts;
    own.longMade += row.kicking.longMade;
    own.returnYards += row.returns.yards;
    own.tackles += row.defence.tackles;
    own.sacks += row.defence.sacks;
    own.hits += row.defence.quarterbackHits;
    own.defended += row.defence.passesDefended;
    own.takeaways += row.defence.interceptions + row.defence.forcedFumbles;
    played.set(row.playerId, own);
  }

  // gather every player's raw attributes first, so the scaling can be
  // measured from them rather than assumed
  const gathered: {
    id: string; name: string; position: string; group: string;
    values: (number | undefined)[];
  }[] = [];
  const seenIds = new Set<string>();

  for (const row of rosters) {
    const id = row.playerId;

    if (!id || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);

    const own = played.get(id);
    const measured = combine.get(
      `${normalizeName(row.name)}|${row.rawPosition}`,
    );
    const pick = row.draftOverall;
    const per = (get: (s: Played) => number) =>
      own && own.games > 0 ? get(own) / own.games : undefined;
    /**
     * A rate needs enough tries behind it. A backup with three throws
     * completes one of them or all three, and those wild values set
     * the spread for every quarterback in the league.
     */
    const rate = (top: number, bottom: number, enough: number) =>
      bottom >= enough ? top / bottom : undefined;

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
      power: Number(measured?.["bench"]) || undefined,
      burst: Number(measured?.["broad_jump"]) || undefined,
      targetShare: own && own.games >= 4 ? per((s) => s.targetShare) : undefined,
      airYardsShare: own && own.games >= 4 ? per((s) => s.airYardsShare) : undefined,
      carriesPerGame: own && own.games >= 4 ? per((s) => s.carries) : undefined,
      catchRate: own && rate(own.receptions, own.targets, 15),
      yardsPerCatch: own && rate(own.recYds, own.receptions, 10),
      airYardsPerTarget: own && rate(own.airYards, own.targets, 15),
      yardsAfterCatch: own && rate(own.afterCatch, own.receptions, 10),
      yardsPerCarry: own && rate(own.rushYds, own.carries, 25),
      scoresPerGame: own && own.games >= 4 ? per((s) => s.scores) : undefined,
      passAttempts: own && own.attempts >= 60 ? per((s) => s.attempts) : undefined,
      completionRate: own && rate(own.completions, own.attempts, 60),
      yardsPerAttempt: own && rate(own.passYds, own.attempts, 60),
      passDepth: own && rate(own.passAir, own.attempts, 60),
      sackRate: own && rate(own.sacked, own.attempts + own.sacked, 60),
      tackles: own && own.games >= 4 ? per((s) => s.tackles) : undefined,
      sacks: own && own.games >= 4 ? per((s) => s.sacks) : undefined,
      quarterbackHits: own && own.games >= 4 ? per((s) => s.hits) : undefined,
      ballsDefended: own && own.games >= 4 ? per((s) => s.defended) : undefined,
      takeaways: own && own.games >= 4 ? per((s) => s.takeaways) : undefined,
      kickAccuracy: own && rate(own.kicksMade, own.kicks, 10),
      legStrength: own && own.longest > 0 ? own.longest : undefined,
      longRange: own && rate(own.longMade, own.longKicks, 4),
      returnYards:
        own && own.returnYards > 0 ? per((s) => s.returnYards) : undefined,
    };

    gathered.push({
      id, name: row.name, position: row.rawPosition,
      group: scaleGroup(row.rawPosition),
      values: ATTRIBUTES.map((attribute) => found[attribute]),
    });
  }

  const scales = measureScale(gathered);
  const out = new Map<string, PlayerVector>();

  for (const player of gathered) {
    const scale = scales.get(player.group)!;
    const values = new Float64Array(ATTRIBUTES.length);

    ATTRIBUTES.forEach((_, i) => {
      const value = player.values[i];
      // a missing attribute sits where its group's middle sits, which
      // is nothing once everything is centred
      values[i] = value === undefined || !Number.isFinite(value)
        ? 0
        : (value - scale.middle[i]!) / scale.spread[i]!;
    });

    out.set(player.id, {
      playerId: player.id, name: player.name, position: player.position, values,
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

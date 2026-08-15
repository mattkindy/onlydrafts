import {
  loadPlayerStats,
  loadSnapCounts,
  loadWeeklyRosters,
} from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";
import { mapPosition } from "../graph/build.js";
import { presets } from "../scoring/fantasyPoints.js";
import { summarizeSeason, type SeasonSummary } from "./seasonSummary.js";
import { primaryQbByTeam, projectedQbByTeam } from "./teamQb.js";
import { fitRidge, predictRidge } from "../backtest/ridge.js";
import { fitGbm, predictGbm, type GbmModel } from "../backtest/gbm.js";
import { loadCoaches } from "../data/coaches.js";
import { loadAdp } from "../data/adp.js";
import { loadTendencies } from "../data/tendencies.js";
import { spearman } from "../backtest/metrics.js";

export const SEASON_POSITIONS = ["QB", "RB", "WR", "TE"];
export const MIN_GAMES = 6;
const MIN_GROUP = 25;

export type Group =
  | "qb-stayer"
  | "qb-mover"
  | "skill-stayer-same-qb"
  | "skill-stayer-new-qb"
  | "skill-mover";

export interface SeasonExample {
  playerId: string;
  position: string;
  prevPpg: number;
  prev2Ppg?: number;
  actualPpg: number;
  moved: boolean;
  group: Group;
  expYears?: number;
  rookieCapital: number;
  snapPct: number;
  /** age in the target season, undefined when the roster omits birth date */
  age?: number;
  /** games played in the previous season, out of 17 */
  gamesPrev: number;
  /** share of previous season points that came from touchdowns */
  tdPointShare: number;
  /** share of the team's five most-used linemen last season still rostered */
  olRetention: number;
  /** the target team's offensive coordinator differs from last season's */
  ocChanged: boolean;
  /** the target team's head coach differs from last season's */
  hcChanged: boolean;
  /** a mover whose new coordinator ran his old team's offense recently */
  ocReunion: boolean;
  /** previous season per-game opportunity */
  targetsPerGame: number;
  carriesPerGame: number;
  airYardsPerGame: number;
  /** preseason market rank for the target season, undefined when unlisted */
  adp?: number;
  /**
   * incoming coordinator's neutral pass rate at his last stop minus
   * this team's rate last season; zero when the staff is unchanged or
   * unknown
   */
  passShift: number;
}

export interface SeasonData {
  stats: Awaited<ReturnType<typeof loadPlayerStats>>;
  summaries: Map<string, SeasonSummary>;
  snapShare: Map<string, number>;
}

export interface SeasonModelFit {
  weight: number;
  ratios: Map<Group, number>;
  ridgeWeights: number[];
  gbm: GbmModel;
}

export const SEASON_RIDGE_FEATURES = [
  "intercept",
  "isQB",
  "isRB",
  "isTE",
  "moved",
  "newQbSkillStayer",
  "young",
  "vet",
  "movedYoung",
  "movedVet",
  "rookieCap",
  "rookieCapRB",
  "age29plus",
  "age29plusRB",
  "gamesFrac",
  "tdShare",
  "olRetention",
  "olRetentionRB",
  "regimeChange",
  "ocOnlyChange",
  "ocReunion",
  "logAdp",
] as const;

async function loadSnapShare(season: number): Promise<Map<string, number>> {
  const weeks = await loadSnapCounts(season);
  const totals = new Map<string, { sum: number; games: number }>();

  for (const week of weeks) {
    const key = `${normalizeName(week.playerName)}|${week.teamId}`;
    const entry = totals.get(key) ?? { sum: 0, games: 0 };
    const pct = week.offensePct > 1.5 ? week.offensePct / 100 : week.offensePct;
    entry.sum += pct;
    entry.games += 1;
    totals.set(key, entry);
  }

  const result = new Map<string, number>();

  for (const [key, { sum, games }] of totals) {
    result.set(key, games === 0 ? 0 : sum / games);
  }

  return result;
}

export async function buildSeasonData(
  seasons: number[],
): Promise<Map<number, SeasonData>> {
  const data = new Map<number, SeasonData>();

  for (const season of seasons) {
    const stats = await loadPlayerStats(season);
    data.set(season, {
      stats,
      summaries: summarizeSeason(stats, presets.ppr),
      snapShare: await loadSnapShare(season),
    });
  }

  return data;
}

export function groupOf(
  position: string,
  moved: boolean,
  qbChanged: boolean,
): Group {
  if (position === "QB") {
    return moved ? "qb-mover" : "qb-stayer";
  }

  if (moved) {
    return "skill-mover";
  }

  return qbChanged ? "skill-stayer-new-qb" : "skill-stayer-same-qb";
}

interface DraftContext {
  entryYear: Map<string, number>;
  birthYear: Map<string, number>;
  rookieCapital: Map<string, number>;
  weekOneTeam: Map<string, string>;
  projectedQb: Map<string, string>;
  prevQb: Map<string, string>;
  /** per team: share of last season's five most-used linemen still rostered */
  olRetention: Map<string, number>;
  ocChanged: Map<string, boolean>;
  hcChanged: Map<string, boolean>;
  coachOf: (team: string, season: number, role: string) => string | undefined;
  passShift: Map<string, number>;
}

interface Lineman {
  playerId: string;
  /** mean offensive snap share last season */
  weight: number;
}

/**
 * Each team's line, weighted by snaps rather than headcount, so
 * losing a 95 percent starter counts near one and losing a rotational
 * body counts near nothing.
 */
function primaryLine(
  roster: Awaited<ReturnType<typeof loadWeeklyRosters>>,
  snapShare: Map<string, number>,
): Map<string, Lineman[]> {
  const seen = new Map<string, Map<string, string>>();

  for (const appearance of roster) {
    if (mapPosition(appearance.rawPosition) !== "OL") {
      continue;
    }

    const perTeam = seen.get(appearance.teamId) ?? new Map<string, string>();
    perTeam.set(appearance.playerId, appearance.name);
    seen.set(appearance.teamId, perTeam);
  }

  const line = new Map<string, Lineman[]>();

  for (const [teamId, players] of seen) {
    const linemen: Lineman[] = [];

    for (const [playerId, name] of players) {
      const weight = snapShare.get(`${normalizeName(name)}|${teamId}`) ?? 0;

      if (weight >= 0.25) {
        linemen.push({ playerId, weight });
      }
    }

    line.set(teamId, linemen);
  }

  return line;
}

async function draftContext(
  target: number,
  prev: SeasonData,
): Promise<DraftContext> {
  const rosterWeekOne = await loadWeeklyRosters(target);
  const prevRoster = await loadWeeklyRosters(target - 1);
  const prevLine = primaryLine(prevRoster, prev.snapShare);
  const targetOl = new Map<string, Set<string>>();

  for (const appearance of rosterWeekOne) {
    if (
      appearance.week === 1 &&
      mapPosition(appearance.rawPosition) === "OL"
    ) {
      const set = targetOl.get(appearance.teamId) ?? new Set<string>();
      set.add(appearance.playerId);
      targetOl.set(appearance.teamId, set);
    }
  }

  const olRetention = new Map<string, number>();

  for (const [teamId, linemen] of prevLine) {
    const current = targetOl.get(teamId);
    const total = linemen.reduce((s, l) => s + l.weight, 0);
    const kept = linemen
      .filter((l) => current?.has(l.playerId))
      .reduce((s, l) => s + l.weight, 0);
    olRetention.set(teamId, total === 0 ? 1 : kept / total);
  }
  const entryYear = new Map<string, number>();
  const rookieCapital = new Map<string, number>();
  const weekOneTeam = new Map<string, string>();

  const birthYear = new Map<string, number>();

  for (const appearance of rosterWeekOne) {
    if (appearance.draftYear !== undefined) {
      entryYear.set(appearance.playerId, appearance.draftYear);
    }

    if (appearance.birthDate) {
      const year = Number(appearance.birthDate.slice(0, 4));

      if (!Number.isNaN(year)) {
        birthYear.set(appearance.playerId, year);
      }
    }

    if (appearance.week === 1) {
      weekOneTeam.set(appearance.playerId, appearance.teamId);
    }

    const position = appearance.rawPosition.toUpperCase();

    if (
      appearance.week === 1 &&
      appearance.draftYear === target &&
      SEASON_POSITIONS.includes(position)
    ) {
      const capital =
        appearance.draftOverall === undefined
          ? 0.05
          : (257 - Math.min(appearance.draftOverall, 257)) / 256;
      const key = `${appearance.teamId}|${position}`;
      rookieCapital.set(key, Math.max(rookieCapital.get(key) ?? 0, capital));
    }
  }

  const coaches = await loadCoaches();
  const tendencies = await loadTendencies();
  const coachOf = (team: string, season: number, role: string) =>
    coaches.get(`${team}|${season}|${role}`);
  const ocChanged = new Map<string, boolean>();
  const hcChanged = new Map<string, boolean>();
  const passShift = new Map<string, number>();

  const ocStops = new Map<string, { team: string; season: number }[]>();

  for (const [key, name] of coaches) {
    const [team, seasonText, role] = key.split("|");

    if (role !== "OC" || !name) {
      continue;
    }

    const list = ocStops.get(name) ?? [];
    list.push({ team: team!, season: Number(seasonText) });
    ocStops.set(name, list);
  }

  for (const teamId of new Set([...olRetention.keys(), ...targetOl.keys()])) {
    const oc = coachOf(teamId, target, "OC");
    const prevOc = coachOf(teamId, target - 1, "OC");
    const hc = coachOf(teamId, target, "HC");
    const prevHc = coachOf(teamId, target - 1, "HC");
    ocChanged.set(teamId, oc === undefined || oc !== prevOc);
    hcChanged.set(teamId, hc === undefined || hc !== prevHc);

    const teamPrev = tendencies.get(`${teamId}|${target - 1}`)?.neutralPassRate;

    if (oc === undefined || oc === prevOc || teamPrev === undefined) {
      passShift.set(teamId, 0);
      continue;
    }

    const stop = (ocStops.get(oc) ?? [])
      .filter((s) => s.season < target && s.team !== teamId)
      .sort((a, b) => b.season - a.season)[0];
    const ocPrev = stop
      ? tendencies.get(`${stop.team}|${stop.season}`)?.neutralPassRate
      : undefined;
    passShift.set(teamId, ocPrev === undefined ? 0 : ocPrev - teamPrev);
  }

  return {
    entryYear,
    birthYear,
    rookieCapital,
    weekOneTeam,
    projectedQb: projectedQbByTeam(rosterWeekOne, prev.summaries),
    prevQb: primaryQbByTeam(prev.stats),
    olRetention,
    ocChanged,
    hcChanged,
    coachOf,
    passShift,
  };
}

export async function examplesForTransition(
  target: number,
  data: Map<number, SeasonData>,
): Promise<SeasonExample[]> {
  const prev = data.get(target - 1)!;
  const current = data.get(target)!;
  const prev2 = data.get(target - 2);
  const context = await draftContext(target, prev);
  const adp = await loadAdp(target).catch(() => new Map());
  const examples: SeasonExample[] = [];

  for (const [playerId, was] of prev.summaries) {
    const is = current.summaries.get(playerId);

    if (!is || !SEASON_POSITIONS.includes(was.position)) {
      continue;
    }

    if (was.games < MIN_GAMES || is.games < MIN_GAMES) {
      continue;
    }

    const moved = was.primaryTeamId !== is.primaryTeamId;
    const targetTeam = is.primaryTeamId;
    const qbChanged =
      context.prevQb.get(targetTeam) !== context.projectedQb.get(targetTeam) ||
      context.projectedQb.get(targetTeam) === undefined;
    const entered = context.entryYear.get(playerId);

    examples.push({
      playerId,
      position: was.position,
      prevPpg: was.pointsPerGame,
      prev2Ppg: prev2?.summaries.get(playerId)?.pointsPerGame,
      actualPpg: is.pointsPerGame,
      moved,
      group: groupOf(was.position, moved, qbChanged),
      expYears: entered === undefined ? undefined : target - entered,
      rookieCapital:
        context.rookieCapital.get(`${targetTeam}|${was.position}`) ?? 0,
      snapPct:
        prev.snapShare.get(
          `${normalizeName(was.playerName)}|${was.primaryTeamId}`,
        ) ?? 0,
      age: ageOf(context, playerId, target),
      gamesPrev: was.games,
      tdPointShare: was.tdPointShare,
      olRetention: context.olRetention.get(targetTeam) ?? 0.6,
      ocChanged: context.ocChanged.get(targetTeam) ?? true,
      hcChanged: context.hcChanged.get(targetTeam) ?? true,
      ocReunion: moved && reunion(context, data, playerId, targetTeam, target),
      targetsPerGame: was.targetsPerGame,
      carriesPerGame: was.carriesPerGame,
      airYardsPerGame: was.airYardsPerGame,
      adp: adp.get(`${normalizeName(was.playerName)}|${was.position}`)?.adp,
      passShift: context.passShift.get(targetTeam) ?? 0,
    });
  }

  return examples;
}

function reunion(
  context: DraftContext,
  data: Map<number, SeasonData>,
  playerId: string,
  targetTeam: string,
  target: number,
): boolean {
  const newOc = context.coachOf(targetTeam, target, "OC");

  if (!newOc) {
    return false;
  }

  for (let s = target - 3; s < target; s++) {
    const oldTeam = data.get(s)?.summaries.get(playerId)?.primaryTeamId;

    if (
      oldTeam &&
      oldTeam !== targetTeam &&
      context.coachOf(oldTeam, s, "OC") === newOc
    ) {
      return true;
    }
  }

  return false;
}

function ageOf(
  context: DraftContext,
  playerId: string,
  target: number,
): number | undefined {
  const born = context.birthYear.get(playerId);
  return born === undefined ? undefined : target - born;
}

export function blended(example: SeasonExample, weight: number): number {
  if (example.prev2Ppg === undefined) {
    return example.prevPpg;
  }

  return (1 - weight) * example.prevPpg + weight * example.prev2Ppg;
}

export function fitBlendWeight(examples: SeasonExample[]): number {
  let bestWeight = 0;
  let bestScore = -Infinity;

  for (let weight = 0; weight <= 0.5; weight += 0.05) {
    const score = spearman(
      examples.map((e) => blended(e, weight)),
      examples.map((e) => e.actualPpg),
    );

    if (score > bestScore) {
      bestScore = score;
      bestWeight = weight;
    }
  }

  return bestWeight;
}

function meanRatio(pairs: [number, number][]): number {
  const ratios = pairs
    .filter(([basis]) => basis > 1)
    .map(([basis, actual]) => Math.min(actual / basis, 3));

  if (ratios.length === 0) {
    return 1;
  }

  return ratios.reduce((s, r) => s + r, 0) / ratios.length;
}

export function fitGroupRatios(
  examples: SeasonExample[],
  weight: number,
): Map<Group, number> {
  const fallback = new Map<boolean, number>();

  for (const moved of [false, true]) {
    fallback.set(
      moved,
      meanRatio(
        examples
          .filter((e) => e.moved === moved)
          .map((e) => [blended(e, weight), e.actualPpg]),
      ),
    );
  }

  const ratios = new Map<Group, number>();
  const groups = new Set(examples.map((e) => e.group));

  for (const group of groups) {
    const members = examples.filter((e) => e.group === group);

    if (members.length < MIN_GROUP) {
      ratios.set(group, fallback.get(members[0]!.moved) ?? 1);
      continue;
    }

    ratios.set(
      group,
      meanRatio(members.map((e) => [blended(e, weight), e.actualPpg])),
    );
  }

  return ratios;
}

export function seasonRidgeRow(e: SeasonExample): number[] {
  const young = e.expYears !== undefined && e.expYears <= 3 ? 1 : 0;
  const vet = e.expYears !== undefined && e.expYears >= 8 ? 1 : 0;
  const moved = e.moved ? 1 : 0;

  return [
    1,
    e.position === "QB" ? 1 : 0,
    e.position === "RB" ? 1 : 0,
    e.position === "TE" ? 1 : 0,
    moved,
    e.group === "skill-stayer-new-qb" ? 1 : 0,
    young,
    vet,
    moved * young,
    moved * vet,
    e.rookieCapital,
    e.position === "RB" ? e.rookieCapital : 0,
    e.age !== undefined && e.age >= 29 ? 1 : 0,
    e.age !== undefined && e.age >= 29 && e.position === "RB" ? 1 : 0,
    e.gamesPrev / 17,
    e.tdPointShare,
    e.olRetention,
    e.position === "RB" ? e.olRetention : 0,
    e.hcChanged ? 1 : 0,
    e.ocChanged && !e.hcChanged ? 1 : 0,
    e.ocReunion ? 1 : 0,
    Math.log(e.adp ?? 250),
  ];
}

export function fitRatioModel(
  examples: SeasonExample[],
  weight: number,
): number[] {
  const usable = examples.filter((e) => blended(e, weight) > 1);
  const X = usable.map(seasonRidgeRow);
  const y = usable.map((e) =>
    Math.log(Math.min(Math.max(e.actualPpg / blended(e, weight), 0.2), 3)),
  );

  return fitRidge(X, y, 5);
}

/** raw signals for the tree model, which finds its own interactions */
export function seasonGbmRow(e: SeasonExample): number[] {
  return [
    e.position === "QB" ? 1 : 0,
    e.position === "RB" ? 1 : 0,
    e.position === "TE" ? 1 : 0,
    e.moved ? 1 : 0,
    e.group === "skill-stayer-new-qb" || e.group === "qb-mover" ? 1 : 0,
    e.expYears ?? 5,
    e.age ?? 27,
    e.rookieCapital,
    e.gamesPrev / 17,
    e.tdPointShare,
    e.olRetention,
    e.snapPct,
    e.prevPpg,
    e.ocChanged ? 1 : 0,
    e.hcChanged ? 1 : 0,
    e.ocReunion ? 1 : 0,
    e.targetsPerGame,
    e.carriesPerGame,
    e.airYardsPerGame,
    Math.log(e.adp ?? 250),
    e.passShift,
    e.position === "RB" ? e.passShift : 0,
  ];
}

export function fitSeasonModel(examples: SeasonExample[]): SeasonModelFit {
  const weight = fitBlendWeight(examples);
  const usable = examples.filter((e) => blended(e, weight) > 1);
  const gbm = fitGbm(
    usable.map(seasonGbmRow),
    usable.map((e) =>
      Math.log(Math.min(Math.max(e.actualPpg / blended(e, weight), 0.2), 3)),
    ),
    { trees: 200, depth: 3, rate: 0.05, minLeaf: 40 },
  );

  return {
    weight,
    ratios: fitGroupRatios(examples, weight),
    ridgeWeights: fitRatioModel(examples, weight),
    gbm,
  };
}

export function predictSeasonGbm(fit: SeasonModelFit, e: SeasonExample): number {
  return blended(e, fit.weight) * Math.exp(predictGbm(fit.gbm, seasonGbmRow(e)));
}

/** ridge and trees average their log adjustments, bracket-oracle style */
export function predictSeasonBlend(
  fit: SeasonModelFit,
  e: SeasonExample,
): number {
  const ridgeAdj = predictRidge(fit.ridgeWeights, seasonRidgeRow(e));
  const gbmAdj = predictGbm(fit.gbm, seasonGbmRow(e));
  return blended(e, fit.weight) * Math.exp((ridgeAdj + gbmAdj) / 2);
}

export function predictSeason(fit: SeasonModelFit, e: SeasonExample): number {
  return (
    blended(e, fit.weight) *
    Math.exp(predictRidge(fit.ridgeWeights, seasonRidgeRow(e)))
  );
}

/**
 * Draft-day projections for a target season, from the previous seasons
 * and the week-1 roster only. Unlike examplesForTransition, nothing
 * here reads the target season's stats, so the board is fair to draft
 * from. actualPpg is set to 0 and never read by prediction.
 */
export async function projectDraftExamples(
  target: number,
  data: Map<number, SeasonData>,
): Promise<SeasonExample[]> {
  const prev = data.get(target - 1)!;
  const prev2 = data.get(target - 2);
  const context = await draftContext(target, prev);
  const adp = await loadAdp(target).catch(() => new Map());
  const examples: SeasonExample[] = [];

  for (const [playerId, was] of prev.summaries) {
    if (!SEASON_POSITIONS.includes(was.position) || was.games < 4) {
      continue;
    }

    const targetTeam =
      context.weekOneTeam.get(playerId) ?? was.primaryTeamId;
    const moved = was.primaryTeamId !== targetTeam;
    const qbChanged =
      context.prevQb.get(targetTeam) !== context.projectedQb.get(targetTeam) ||
      context.projectedQb.get(targetTeam) === undefined;
    const entered = context.entryYear.get(playerId);

    const example: SeasonExample = {
      playerId,
      position: was.position,
      prevPpg: was.pointsPerGame,
      prev2Ppg: prev2?.summaries.get(playerId)?.pointsPerGame,
      actualPpg: 0,
      moved,
      group: groupOf(was.position, moved, qbChanged),
      expYears: entered === undefined ? undefined : target - entered,
      rookieCapital:
        context.rookieCapital.get(`${targetTeam}|${was.position}`) ?? 0,
      snapPct: 0,
      age: ageOf(context, playerId, target),
      gamesPrev: was.games,
      tdPointShare: was.tdPointShare,
      olRetention: context.olRetention.get(targetTeam) ?? 0.6,
      ocChanged: context.ocChanged.get(targetTeam) ?? true,
      hcChanged: context.hcChanged.get(targetTeam) ?? true,
      ocReunion: moved && reunion(context, data, playerId, targetTeam, target),
      targetsPerGame: was.targetsPerGame,
      carriesPerGame: was.carriesPerGame,
      airYardsPerGame: was.airYardsPerGame,
      adp: adp.get(`${normalizeName(was.playerName)}|${was.position}`)?.adp,
      passShift: context.passShift.get(targetTeam) ?? 0,
    };

    examples.push(example);
  }

  return examples;
}

export async function projectDraftBoard(
  target: number,
  data: Map<number, SeasonData>,
  fit: SeasonModelFit,
): Promise<Map<string, number>> {
  const examples = await projectDraftExamples(target, data);
  return new Map(examples.map((e) => [e.playerId, predictSeason(fit, e)]));
}

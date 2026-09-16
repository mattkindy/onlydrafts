import {
  loadPlayerStats,
  loadSnapCounts,
  loadWeeklyRosters,
} from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";
import { mapPosition } from "../graph/build.js";
import { scoring } from "../scoring/active.js";
import {
  summarizeSeason, type SeasonSummary, type StatParts,
} from "./seasonSummary.js";
import { primaryQbByTeam, projectedQbByTeam } from "./teamQb.js";
import { fitRidge, predictRidge } from "../backtest/ridge.js";
import { fitGbm, predictGbm, type GbmModel } from "../backtest/gbm.js";
import { loadAdp } from "../data/adp.js";
import { staffChangesFor } from "./staffChange.js";
import { loadCompromisedWeeks, loadInjuryDetail } from "../data/injuries.js";
import { fantasyPoints } from "../scoring/fantasyPoints.js";
import { spearman } from "../backtest/metrics.js";

const SEASON_POSITIONS = ["QB", "RB", "WR", "TE"];
const MIN_GAMES = 6;
const MIN_GROUP = 25;

type Group =
  | "qb-stayer"
  | "qb-mover"
  | "skill-stayer-same-qb"
  | "skill-stayer-new-qb"
  | "skill-mover";

export interface SeasonExample {
  playerId: string;
  /**
   * What the season he was read from calls him. A player who missed last
   * season is not in last season's summaries, so anyone naming him
   * from there gets his gsis id on the page instead.
   */
  playerName?: string;
  position: string;
  prevPpg: number;
  /** the same three seasons in yards and catches, which no league scores */
  prevParts?: StatParts;
  prev2Parts?: StatParts;
  actualParts?: StatParts;
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
  /** how his previous season started and finished, points a game */
  earlyPpg: number;
  latePpg: number;
  /** last season's scoring in games he was not on the injury report */
  healthyPpg?: number;
  /** share of last season's games he played while listed */
  compromised: number;
  /** scoring clear of the report and its shadow */
  clearPpg?: number;
  /** share of last season's games inside a soft tissue shadow */
  softShadow: number;
  /** his own NFL draft capital, 0 to 1 */
  ownCapital: number;
  /** the best rival at his position on his team, by recent scoring */
  rivalPpg: number;
  /** that position group's best draft capital other than his own */
  rivalCapital: number;
  /** how much of the position group's recent production belongs to him */
  ownShare: number;
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
  /** points per game in weeks he was not on the injury report */
  healthyPpg: Map<string, number>;
  /** share of his games played while listed */
  compromised: Map<string, number>;
  /** scoring in games clear of the report and its three week shadow */
  clearPpg: Map<string, number>;
  /** share of his games inside the shadow of a soft tissue injury */
  softShadow: Map<string, number>;
}

interface SeasonModelFit {
  baseline: Baseline;
  ratios: Map<Group, number>;
  ridgeWeights: number[];
  gbm: GbmModel;
}

/**
 * The level a season projection starts from, before the ridge and the
 * trees move it.
 *
 * A player's own scoring last season is most of it. Two things temper
 * that: how many games it was measured over, and how much of the
 * offence he was on the field for.
 */
interface Baseline {
  /** how much of the read comes from the season before last */
  weight: number;
  level: RoleLevel;
  /** games before a player's own average is taken at face value */
  steadyGames: number;
}

/**
 * What players at a position scored at each snap share, as a straight
 * line per position with the position's mean behind it.
 *
 * Someone who played a third of the snaps is not a poor starter, he is
 * a part time player, and the position's mean is the wrong place to
 * pull his small sample toward. What his snap share usually pays is
 * the right place.
 */
interface RoleLevel {
  byPosition: Map<string, { weights: number[]; mean: number }>;
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
  "finishedStrong",
  "healthyBoost",
  "playedHurtShare",
  "clearBoost",
  "softShadowShare",
  "positionGroupShare",
  "rivalOverMe",
  "snapShare",
  "snapsOnFile",
  "scoringOverSnapShare",
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
    // the upcoming season has rosters but no games yet, so its stats and
    // snaps are missing until week 1
    const stats = await loadPlayerStats(season).catch(() => []);
    const hurt = await loadCompromisedWeeks(season).catch(() => new Set<string>());
    const detail = await loadInjuryDetail(season).catch(
      () => new Map<string, { week: number; kind: string; softTissue: boolean }[]>(),
    );
    const SHADOW_WEEKS = 3;
    const clear = new Map<string, { points: number; games: number }>();
    const shadowed = new Map<string, { soft: number; games: number }>();
    const healthy = new Map<string, { points: number; games: number }>();
    const listed = new Map<string, { hurt: number; games: number }>();

    for (const row of stats) {
      const tally = listed.get(row.playerId) ?? { hurt: 0, games: 0 };
      tally.games++;

      if (hurt.has(`${row.playerId}|${row.week}`)) {
        tally.hurt++;
      } else {
        const clean = healthy.get(row.playerId) ?? { points: 0, games: 0 };
        clean.points += fantasyPoints(row.statLine, scoring());
        clean.games++;
        healthy.set(row.playerId, clean);
      }

      listed.set(row.playerId, tally);

      const history = detail.get(row.playerId) ?? [];
      const recent = history.filter(
        (i) => i.week < row.week && row.week - i.week <= SHADOW_WEEKS,
      );
      const inShadow = recent.length > 0 || hurt.has(`${row.playerId}|${row.week}`);
      const softly = recent.some((i) => i.softTissue);
      const shade = shadowed.get(row.playerId) ?? { soft: 0, games: 0 };
      shade.games++;

      if (softly) {
        shade.soft++;
      }

      shadowed.set(row.playerId, shade);

      if (!inShadow) {
        const entry = clear.get(row.playerId) ?? { points: 0, games: 0 };
        entry.points += fantasyPoints(row.statLine, scoring());
        entry.games++;
        clear.set(row.playerId, entry);
      }
    }

    data.set(season, {
      stats,
      summaries: summarizeSeason(stats, scoring()),
      snapShare: await loadSnapShare(season).catch(() => new Map<string, number>()),
      healthyPpg: new Map(
        [...healthy.entries()]
          .filter(([, v]) => v.games >= 3)
          .map(([id, v]) => [id, v.points / v.games]),
      ),
      compromised: new Map(
        [...listed.entries()].map(([id, v]) => [id, v.games ? v.hurt / v.games : 0]),
      ),
      clearPpg: new Map(
        [...clear.entries()]
          .filter(([, v]) => v.games >= 3)
          .map(([id, v]) => [id, v.points / v.games]),
      ),
      softShadow: new Map(
        [...shadowed.entries()].map(([id, v]) => [id, v.games ? v.soft / v.games : 0]),
      ),
    });
  }

  return data;
}

function groupOf(
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

interface PositionGroupPlayer {
  playerId: string;
  /** 0 to 1, higher for an earlier NFL draft pick */
  capital: number;
  /** recency weighted scoring, last season counting most */
  recentPpg: number;
  rookie: boolean;
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
  /** per team and position: everyone competing there next season */
  byPositionGroup: Map<string, PositionGroupPlayer[]>;
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
  prev2Summaries_?: Map<string, SeasonSummary>,
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

  const byPositionGroup = new Map<string, PositionGroupPlayer[]>();
  const prev2Summaries = prev2Summaries_;

  for (const appearance of rosterWeekOne) {
    if (appearance.week !== 1) {
      continue;
    }

    const position = appearance.rawPosition.toUpperCase();

    if (!SEASON_POSITIONS.includes(position)) {
      continue;
    }

    const last = prev.summaries.get(appearance.playerId);
    const before = prev2Summaries?.get(appearance.playerId);
    const key = `${appearance.teamId}|${position}`;
    const list = byPositionGroup.get(key) ?? [];
    list.push({
      playerId: appearance.playerId,
      capital:
        appearance.draftOverall === undefined
          ? 0.05
          : (257 - Math.min(appearance.draftOverall, 257)) / 256,
      recentPpg:
        last && before
          ? 0.75 * last.pointsPerGame + 0.25 * before.pointsPerGame
          : (last?.pointsPerGame ?? 0),
      rookie: appearance.draftYear === target,
    });
    byPositionGroup.set(key, list);
  }

  const staff = await staffChangesFor(target);
  const ocChanged = new Map<string, boolean>();
  const hcChanged = new Map<string, boolean>();
  const passShift = new Map<string, number>();

  for (const teamId of new Set([...olRetention.keys(), ...targetOl.keys()])) {
    const change = staff.changes.get(teamId);
    ocChanged.set(teamId, change?.ocChanged ?? false);
    hcChanged.set(teamId, change?.hcChanged ?? false);
    passShift.set(teamId, change?.passShift ?? 0);
  }

  return {
    entryYear,
    birthYear,
    rookieCapital,
    weekOneTeam,
    projectedQb: projectedQbByTeam(rosterWeekOne, prev.summaries),
    prevQb: primaryQbByTeam(prev.stats),
    byPositionGroup,
    olRetention,
    ocChanged,
    hcChanged,
    coachOf: staff.coachOf,
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
  const context = await draftContext(target, prev, prev2?.summaries);
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
      prevParts: was.perGame,
      prev2Parts: prev2?.summaries.get(playerId)?.perGame,
      actualParts: is.perGame,
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
      earlyPpg: was.earlyPpg,
      latePpg: was.latePpg,
      healthyPpg: prev.healthyPpg.get(playerId),
      compromised: prev.compromised.get(playerId) ?? 0,
      clearPpg: prev.clearPpg.get(playerId),
      softShadow: prev.softShadow.get(playerId) ?? 0,
      ...positionGroupFeatures(
        context, playerId, targetTeam, was.position, was.pointsPerGame,
      ),
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


function positionGroupFeatures(
  context: DraftContext,
  playerId: string,
  team: string,
  position: string,
  ownPpg: number,
): {
  ownCapital: number;
  rivalPpg: number;
  rivalCapital: number;
  ownShare: number;
} {
  const group = context.byPositionGroup.get(`${team}|${position}`) ?? [];
  const me = group.find((r) => r.playerId === playerId);
  const rivals = group.filter((r) => r.playerId !== playerId);
  const totalPpg =
    rivals.reduce((s, r) => s + r.recentPpg, 0) + Math.max(ownPpg, 0);

  return {
    ownCapital: me?.capital ?? 0.05,
    rivalPpg: rivals.reduce((best, r) => Math.max(best, r.recentPpg), 0),
    rivalCapital: rivals.reduce((best, r) => Math.max(best, r.capital), 0),
    ownShare: totalPpg > 0 ? Math.max(ownPpg, 0) / totalPpg : 0.5,
  };
}

function ageOf(
  context: DraftContext,
  playerId: string,
  target: number,
): number | undefined {
  const born = context.birthYear.get(playerId);
  return born === undefined ? undefined : target - born;
}

/** the fewest players with snaps on file before a position gets a line */
const ENOUGH_FOR_ROLE = 30;

/** the widest shrinkage the fit will consider, in games */
const MOST_SHRINKAGE = 20;

const roleRow = (e: SeasonExample): number[] => [1, e.snapPct];

function fitRoleLevel(examples: SeasonExample[]): RoleLevel {
  const byPosition = new Map<string, { weights: number[]; mean: number }>();

  for (const position of SEASON_POSITIONS) {
    const rows = examples.filter((e) => e.position === position);

    if (rows.length === 0) {
      continue;
    }

    const mean = rows.reduce((s, e) => s + e.prevPpg, 0) / rows.length;
    const onFile = rows.filter((e) => e.snapPct > 0);
    byPosition.set(position, {
      mean,
      weights:
        onFile.length >= ENOUGH_FOR_ROLE
          ? fitRidge(onFile.map(roleRow), onFile.map((e) => e.prevPpg), 1)
          : [],
    });
  }

  return { byPosition };
}

/** what his position usually scores at his snap share */
function roleLevel(level: RoleLevel, e: SeasonExample): number {
  const fitted = level.byPosition.get(e.position);

  if (!fitted) {
    return 0;
  }

  if (e.snapPct <= 0 || fitted.weights.length === 0) {
    return fitted.mean;
  }

  return Math.max(0, predictRidge(fitted.weights, roleRow(e)));
}

function ownAverage(example: SeasonExample, weight: number): number {
  if (example.prev2Ppg === undefined) {
    return example.prevPpg;
  }

  return (1 - weight) * example.prevPpg + weight * example.prev2Ppg;
}

function blended(example: SeasonExample, base: Baseline): number {
  const own = ownAverage(example, base.weight);

  if (base.steadyGames <= 0) {
    return own;
  }

  const trust = example.gamesPrev / (example.gamesPrev + base.steadyGames);

  return trust * own + (1 - trust) * roleLevel(base.level, example);
}

function fitBlendWeight(
  examples: SeasonExample[],
  level: RoleLevel,
  steadyGames: number,
): number {
  let bestWeight = 0;
  let bestScore = -Infinity;

  for (let weight = 0; weight <= 0.5; weight += 0.05) {
    const score = spearman(
      examples.map((e) => blended(e, { weight, level, steadyGames })),
      examples.map((e) => e.actualPpg),
    );

    if (score > bestScore) {
      bestScore = score;
      bestWeight = weight;
    }
  }

  return bestWeight;
}

/**
 * How many games of his own it takes before a player's average is read
 * at face value, chosen by whichever shrinkage predicts the training
 * seasons best. Nine seasons of players land it around five, and
 * anything from two to eight scores about the same.
 */
function fitSteadyGames(
  examples: SeasonExample[],
  level: RoleLevel,
): number {
  let best = 0;
  let bestError = Infinity;

  for (let steadyGames = 0; steadyGames <= MOST_SHRINKAGE; steadyGames++) {
    const base: Baseline = { weight: 0, level, steadyGames };
    const error =
      examples.reduce((s, e) => s + Math.abs(blended(e, base) - e.actualPpg), 0) /
      Math.max(1, examples.length);

    if (error < bestError) {
      bestError = error;
      best = steadyGames;
    }
  }

  return best;
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

function fitGroupRatios(
  examples: SeasonExample[],
  base: Baseline,
): Map<Group, number> {
  const fallback = new Map<boolean, number>();

  for (const moved of [false, true]) {
    fallback.set(
      moved,
      meanRatio(
        examples
          .filter((e) => e.moved === moved)
          .map((e) => [blended(e, base), e.actualPpg]),
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
      meanRatio(members.map((e) => [blended(e, base), e.actualPpg])),
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
    e.prevPpg > 0 ? (e.latePpg - e.earlyPpg) / Math.max(4, e.prevPpg) : 0,
    e.healthyPpg !== undefined && e.prevPpg > 0
      ? (e.healthyPpg - e.prevPpg) / Math.max(4, e.prevPpg)
      : 0,
    e.compromised,
    e.clearPpg !== undefined && e.prevPpg > 0
      ? (e.clearPpg - e.prevPpg) / Math.max(4, e.prevPpg)
      : 0,
    e.softShadow,
    e.ownShare,
    e.prevPpg > 0 ? Math.min(2, e.rivalPpg / Math.max(4, e.prevPpg)) : 0,
    e.snapPct,
    e.snapPct > 0 ? 1 : 0,
    // scoring against the snap share it came off, so a part time player
    // who scored like a starter is read as the outlier he is
    e.snapPct > 0
      ? Math.log(Math.max(e.prevPpg, 0.5) / Math.max(e.snapPct, 0.05))
      : 0,
  ];
}

function fitRatioModel(
  examples: SeasonExample[],
  base: Baseline,
): number[] {
  const usable = examples.filter((e) => blended(e, base) > 1);
  const X = usable.map(seasonRidgeRow);
  const y = usable.map((e) =>
    Math.log(Math.min(Math.max(e.actualPpg / blended(e, base), 0.2), 3)),
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
    e.earlyPpg,
    e.latePpg,
    e.healthyPpg ?? e.prevPpg,
    e.compromised,
    e.clearPpg !== undefined && e.prevPpg > 0
      ? (e.clearPpg - e.prevPpg) / Math.max(4, e.prevPpg)
      : 0,
    e.softShadow,
    e.ownShare,
    e.prevPpg > 0 ? Math.min(2, e.rivalPpg / Math.max(4, e.prevPpg)) : 0,
  ];
}

export function fitSeasonModel(examples: SeasonExample[]): SeasonModelFit {
  const level = fitRoleLevel(examples);
  const steadyGames = fitSteadyGames(examples, level);
  const baseline: Baseline = {
    weight: fitBlendWeight(examples, level, steadyGames),
    level,
    steadyGames,
  };
  const usable = examples.filter((e) => blended(e, baseline) > 1);
  const gbm = fitGbm(
    usable.map(seasonGbmRow),
    usable.map((e) =>
      Math.log(Math.min(Math.max(e.actualPpg / blended(e, baseline), 0.2), 3)),
    ),
    { trees: 200, depth: 3, rate: 0.05, minLeaf: 40 },
  );

  return {
    baseline,
    ratios: fitGroupRatios(examples, baseline),
    ridgeWeights: fitRatioModel(examples, baseline),
    gbm,
  };
}

function predictSeasonGbm(fit: SeasonModelFit, e: SeasonExample): number {
  return blended(e, fit.baseline) * Math.exp(predictGbm(fit.gbm, seasonGbmRow(e)));
}

/** ridge and trees average their log adjustments, bracket-oracle style */
export function predictSeasonBlend(
  fit: SeasonModelFit,
  e: SeasonExample,
): number {
  const ridgeAdj = predictRidge(fit.ridgeWeights, seasonRidgeRow(e));
  const gbmAdj = predictGbm(fit.gbm, seasonGbmRow(e));
  return blended(e, fit.baseline) * Math.exp((ridgeAdj + gbmAdj) / 2);
}

function predictSeason(fit: SeasonModelFit, e: SeasonExample): number {
  return (
    blended(e, fit.baseline) *
    Math.exp(predictRidge(fit.ridgeWeights, seasonRidgeRow(e)))
  );
}

/**
 * How far back the board will reach for a player who did not play last
 * season. One season, so a player who spent a year on injured reserve
 * still gets a row. Past that his numbers are too old to project from,
 * and the rookie path picks him up instead.
 */
const STALE_SEASONS = 1;

/** enough of a season to say what a player is */
const ENOUGH_GAMES = 4;

/**
 * Whether the board has a season of this player it can project from.
 *
 * False for a rookie, and false too for a player whose last season of
 * four games or more is older than the board reaches, or who has
 * never had one. Those players
 * are projected from their draft slot and their side instead.
 */
export function hasSeasonToRead(
  playerId: string,
  target: number,
  data: Map<number, SeasonData>,
): boolean {
  for (let back = 1; back <= 1 + STALE_SEASONS; back++) {
    const was = data.get(target - back)?.summaries.get(playerId);

    if (was && SEASON_POSITIONS.includes(was.position) &&
      was.games >= ENOUGH_GAMES) {
      return true;
    }
  }

  return false;
}

/**
 * The last season each player played, along with the season data it came
 * from, so the features that read his season read the right one.
 *
 * A player who missed all of last season used to have no row at all,
 * because the board was built by walking last season's summaries. He
 * kept his roster spot and the model had three years of him on file,
 * and he still came out of the build as though he had retired.
 */
function lastSeasonPlayed(
  target: number,
  data: Map<number, SeasonData>,
  context: DraftContext,
): {
  playerId: string;
  was: SeasonSummary;
  from: SeasonData;
  older: Map<string, SeasonSummary> | undefined;
}[] {
  const found = new Map<string, {
    playerId: string;
    was: SeasonSummary;
    from: SeasonData;
    older: Map<string, SeasonSummary> | undefined;
  }>();

  for (let back = 1; back <= 1 + STALE_SEASONS; back++) {
    const from = data.get(target - back);

    if (!from) {
      continue;
    }

    for (const [playerId, was] of from.summaries) {
      if (
        found.has(playerId) ||
        !SEASON_POSITIONS.includes(was.position) ||
        was.games < ENOUGH_GAMES
      ) {
        continue;
      }

      // Reaching past last season is only safe for a player somebody has
      // put on a roster this year. Without it the board fills up with
      // everyone who has ever retired.
      if (back > 1 && !context.weekOneTeam.has(playerId)) {
        continue;
      }

      found.set(playerId, {
        playerId, was, from, older: data.get(target - back - 1)?.summaries,
      });
    }
  }

  return [...found.values()];
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
  const context = await draftContext(target, prev, prev2?.summaries);
  const adp = await loadAdp(target).catch(() => new Map());
  const examples: SeasonExample[] = [];

  for (const { playerId, was, from, older } of lastSeasonPlayed(
    target, data, context,
  )) {
    const targetTeam =
      context.weekOneTeam.get(playerId) ?? was.primaryTeamId;
    const moved = was.primaryTeamId !== targetTeam;
    const qbChanged =
      context.prevQb.get(targetTeam) !== context.projectedQb.get(targetTeam) ||
      context.projectedQb.get(targetTeam) === undefined;
    const entered = context.entryYear.get(playerId);

    const example: SeasonExample = {
      playerId,
      playerName: was.playerName,
      position: was.position,
      prevPpg: was.pointsPerGame,
      prev2Ppg: older?.get(playerId)?.pointsPerGame,
      actualPpg: 0,
      prevParts: was.perGame,
      prev2Parts: older?.get(playerId)?.perGame,
      moved,
      group: groupOf(was.position, moved, qbChanged),
      expYears: entered === undefined ? undefined : target - entered,
      rookieCapital:
        context.rookieCapital.get(`${targetTeam}|${was.position}`) ?? 0,
      // last season's snap share, the same reading the training rows get.
      // It was zero here, so the model met a feature at prediction time
      // that it had never seen empty while it was learning.
      snapPct:
        from.snapShare.get(
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
      earlyPpg: was.earlyPpg,
      latePpg: was.latePpg,
      healthyPpg: from.healthyPpg.get(playerId),
      compromised: from.compromised.get(playerId) ?? 0,
      clearPpg: from.clearPpg.get(playerId),
      softShadow: from.softShadow.get(playerId) ?? 0,
      ...positionGroupFeatures(
        context, playerId, targetTeam, was.position, was.pointsPerGame,
      ),
      adp: adp.get(`${normalizeName(was.playerName)}|${was.position}`)?.adp,
      passShift: context.passShift.get(targetTeam) ?? 0,
    };

    examples.push(example);
  }

  return examples;
}

async function projectDraftBoard(
  target: number,
  data: Map<number, SeasonData>,
  fit: SeasonModelFit,
): Promise<Map<string, number>> {
  const examples = await projectDraftExamples(target, data);
  return new Map(examples.map((e) => [e.playerId, predictSeason(fit, e)]));
}

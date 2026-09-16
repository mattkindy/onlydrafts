/**
 * A week's points built from a player's opportunities times his per-touch
 * rates, rather than from a model anchored to his season.
 *
 * Usage is his own recent workload per game, mixed with his previous
 * season while he has fewer than three games behind him. Rates come from
 * the same history, shrunk toward the league average for his position.
 *
 * The season anchor used to sit on the August number all year, so this
 * line used to carry the early weeks on its own. Now the anchor moves
 * with the games played (updateBoardLevels in inSeasonBoard.ts), and
 * scripts/crossFadeAnchorEval.ts found it beats this line even at week
 * 1, so the fade below is off.
 */

import type { PlayerWeekStats } from "../data/nflverse.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";

/** the last week the component line would run at full weight, were the fade on */
export const COMPONENT_FADE_FROM_WEEK = 0;

/** the week the season anchor takes over; 0 here turns the fade off entirely */
export const COMPONENT_FADE_TO_WEEK = 0;

/**
 * How much of a week's number comes from the component line rather than
 * the season anchor: 1 through COMPONENT_FADE_FROM_WEEK, falling in a
 * straight line to 0 by COMPONENT_FADE_TO_WEEK. With both at 0, week is
 * never at or below COMPONENT_FADE_FROM_WEEK and always at or above
 * COMPONENT_FADE_TO_WEEK, so this returns 0 for every real week and the
 * component line never runs for a week numbered 1 or higher.
 */
export function componentWeight(week: number): number {
  if (week <= COMPONENT_FADE_FROM_WEEK) {
    return 1;
  }

  if (week >= COMPONENT_FADE_TO_WEEK) {
    return 0;
  }

  return (COMPONENT_FADE_TO_WEEK - week) /
    (COMPONENT_FADE_TO_WEEK - COMPONENT_FADE_FROM_WEEK);
}

/**
 * A week's number, cross faded between the component line and the
 * season anchor. `component` is left out where there is no history
 * to build it from, so the anchor is used alone.
 */
export function blendWithComponent(
  week: number,
  component: number | undefined,
  anchored: number,
): number {
  const weight = componentWeight(week);

  if (weight <= 0 || component === undefined) {
    return anchored;
  }

  return weight * component + (1 - weight) * anchored;
}

/** how many of a player's own games the trailing window reads */
const COMPONENT_WINDOW = 4;

/** the positions the component model has priors and rates for */
const COMPONENT_POSITIONS = ["QB", "RB", "WR", "TE"];

/** the opportunities a projection multiplies a rate by */
interface Usage {
  passAtt: number;
  carries: number;
  targets: number;
}

/** per-opportunity rates, which is what shrinks toward a position prior */
export interface Rates {
  ypa: number;
  passTdRate: number;
  intRate: number;
  ypc: number;
  rushTdRate: number;
  ypt: number;
  catchRate: number;
  recTdRate: number;
}

/** what a player did over some stretch, on both sides of usage times rate */
interface Box extends Usage {
  passYds: number;
  passTd: number;
  interceptions: number;
  rushYds: number;
  rushTd: number;
  receptions: number;
  recYds: number;
  recTd: number;
  points: number;
}

/** how many opportunities a rate needs before it stops being the prior */
const SHRINK = { passAtt: 80, carries: 40, targets: 30 };

export const emptyBox = (): Box => ({
  passAtt: 0, carries: 0, targets: 0, passYds: 0, passTd: 0,
  interceptions: 0, rushYds: 0, rushTd: 0, receptions: 0, recYds: 0,
  recTd: 0, points: 0,
});

function boxOf(s: PlayerWeekStats, rules: ScoringRules): Box {
  const line = s.statLine;

  return {
    passAtt: s.passing.attempts,
    carries: s.carries,
    targets: s.targets,
    passYds: line.passYds,
    passTd: line.passTd,
    interceptions: line.interceptions,
    rushYds: line.rushYds,
    rushTd: line.rushTd,
    receptions: line.receptions,
    recYds: line.recYds,
    recTd: line.recTd,
    points: fantasyPoints(line, rules),
  };
}

function addBox(into: Box, from: Box): void {
  for (const key of Object.keys(into) as (keyof Box)[]) {
    into[key] += from[key];
  }
}

/** per game over whichever window a caller is reading */
function perGame(box: Box, count: number): Box {
  if (count <= 0) {
    return emptyBox();
  }

  const out = emptyBox();

  for (const key of Object.keys(out) as (keyof Box)[]) {
    out[key] = box[key] / count;
  }

  return out;
}

const usageOf = (box: Box): Usage => ({
  passAtt: box.passAtt, carries: box.carries, targets: box.targets,
});

function scaleUsage(usage: Usage, by: number): Usage {
  return {
    passAtt: usage.passAtt * by,
    carries: usage.carries * by,
    targets: usage.targets * by,
  };
}

function mixUsage(a: Usage, b: Usage, weight: number): Usage {
  return {
    passAtt: (1 - weight) * a.passAtt + weight * b.passAtt,
    carries: (1 - weight) * a.carries + weight * b.carries,
    targets: (1 - weight) * a.targets + weight * b.targets,
  };
}

/**
 * Points from a player's opportunities and his rates, under the league's
 * rules. This is the whole component model in one place, so a candidate
 * differs only in where its usage and its rates come from.
 */
function pointsFrom(
  usage: Usage,
  rates: Rates,
  rules: ScoringRules,
): number {
  const passing = usage.passAtt *
    (rules.passYds * rates.ypa + rules.passTd * rates.passTdRate +
      rules.interceptions * rates.intRate);
  const rushing = usage.carries *
    (rules.rushYds * rates.ypc + rules.rushTd * rates.rushTdRate);
  const receiving = usage.targets *
    (rules.recYds * rates.ypt + rules.receptions * rates.catchRate +
      rules.recTd * rates.recTdRate);

  return passing + rushing + receiving;
}

function ratesFrom(box: Box, prior: Rates, shrink = SHRINK): Rates {
  const per = (total: number, count: number, k: number, floor: number) =>
    (total + k * floor) / (count + k);

  return {
    ypa: per(box.passYds, box.passAtt, shrink.passAtt, prior.ypa),
    passTdRate: per(box.passTd, box.passAtt, shrink.passAtt, prior.passTdRate),
    intRate: per(box.interceptions, box.passAtt, shrink.passAtt, prior.intRate),
    ypc: per(box.rushYds, box.carries, shrink.carries, prior.ypc),
    rushTdRate: per(box.rushTd, box.carries, shrink.carries, prior.rushTdRate),
    ypt: per(box.recYds, box.targets, shrink.targets, prior.ypt),
    catchRate: per(box.receptions, box.targets, shrink.targets, prior.catchRate),
    recTdRate: per(box.recTd, box.targets, shrink.targets, prior.recTdRate),
  };
}

/** the same rates with no shrinkage, which is what one stretch itself says */
function rawRates(box: Box, prior: Rates): Rates {
  const per = (total: number, count: number, floor: number) =>
    count > 0 ? total / count : floor;

  return {
    ypa: per(box.passYds, box.passAtt, prior.ypa),
    passTdRate: per(box.passTd, box.passAtt, prior.passTdRate),
    intRate: per(box.interceptions, box.passAtt, prior.intRate),
    ypc: per(box.rushYds, box.carries, prior.ypc),
    rushTdRate: per(box.rushTd, box.carries, prior.rushTdRate),
    ypt: per(box.recYds, box.targets, prior.ypt),
    catchRate: per(box.receptions, box.targets, prior.catchRate),
    recTdRate: per(box.recTd, box.targets, prior.recTdRate),
  };
}

/**
 * League-average rates for each position over whatever weeks the caller
 * hands in. Pass several seasons of weekly stats: the more there are, the
 * less a prior moves with one year's officiating.
 */
export function positionRatePriors(
  weeks: Iterable<PlayerWeekStats>,
  rules: ScoringRules,
): Map<string, Rates> {
  const totals = new Map<string, Box>();

  for (const s of weeks) {
    if (!COMPONENT_POSITIONS.includes(s.position)) {
      continue;
    }

    const into = totals.get(s.position) ?? emptyBox();
    addBox(into, boxOf(s, rules));
    totals.set(s.position, into);
  }

  const priors = new Map<string, Rates>();

  for (const [position, box] of totals) {
    const per = (total: number, count: number) => (count > 0 ? total / count : 0);
    priors.set(position, {
      ypa: per(box.passYds, box.passAtt),
      passTdRate: per(box.passTd, box.passAtt),
      intRate: per(box.interceptions, box.passAtt),
      ypc: per(box.rushYds, box.carries),
      rushTdRate: per(box.rushTd, box.carries),
      ypt: per(box.recYds, box.targets),
      catchRate: per(box.receptions, box.targets),
      recTdRate: per(box.recTd, box.targets),
    });
  }

  return priors;
}

/** everything about a player the component line is allowed to look at */
export interface History {
  /** his last few games played this season, summed, and how many */
  trailing: Box;
  trailingGames: number;
  /** his whole previous season, summed, and the games it took */
  prev: Box;
  prevGames: number;
}

/**
 * The per-game usage the component line works from. Vegas is left out on
 * purpose: scaling a player's touches by his side's implied total cost a
 * tenth of a point at every position on the bench.
 */
export function componentUsage(history: History): Usage {
  const recent = usageOf(perGame(history.trailing, history.trailingGames));
  const before = usageOf(perGame(history.prev, history.prevGames));

  if (history.trailingGames >= 3 || history.prevGames === 0) {
    return recent;
  }

  return mixUsage(before, recent, history.trailingGames / 3);
}

/** what a player's own history says his rates are, prior season included */
export function componentRates(history: History, prior: Rates): Rates {
  const box = emptyBox();
  addBox(box, history.trailing);
  addBox(box, history.prev);

  return ratesFrom(box, prior);
}

/** the component line itself: his usage times his shrunk rates */
export function componentPoints(
  history: History,
  prior: Rates,
  rules: ScoringRules,
): number {
  return pointsFrom(
    componentUsage(history),
    componentRates(history, prior),
    rules,
  );
}

/**
 * Each player's trailing window and previous season as of one week. `stats`
 * is this season's weekly stats and `prevStats` last season's; only the
 * weeks before `week` count toward the trailing box, so the same call
 * works for a week that has already been played.
 */
export function historiesForWeek(
  stats: PlayerWeekStats[],
  prevStats: PlayerWeekStats[],
  week: number,
  rules: ScoringRules,
  window = COMPONENT_WINDOW,
): Map<string, History> {
  const prev = new Map<string, { box: Box; games: number }>();

  for (const s of prevStats) {
    const his = prev.get(s.playerId) ?? { box: emptyBox(), games: 0 };
    addBox(his.box, boxOf(s, rules));
    his.games++;
    prev.set(s.playerId, his);
  }

  const played = new Map<string, PlayerWeekStats[]>();

  for (const s of stats) {
    if (s.week >= week) {
      continue;
    }

    played.set(s.playerId, [...(played.get(s.playerId) ?? []), s]);
  }

  const out = new Map<string, History>();
  const ids = new Set([...prev.keys(), ...played.keys()]);

  for (const playerId of ids) {
    const sorted = [...(played.get(playerId) ?? [])].sort(
      (a, b) => a.week - b.week,
    );
    const recent = sorted.slice(Math.max(0, sorted.length - window));
    const trailing = emptyBox();

    for (const s of recent) {
      addBox(trailing, boxOf(s, rules));
    }

    const before = prev.get(playerId);
    out.set(playerId, {
      trailing,
      trailingGames: recent.length,
      prev: before?.box ?? emptyBox(),
      prevGames: before?.games ?? 0,
    });
  }

  return out;
}

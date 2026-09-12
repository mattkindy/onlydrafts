/**
 * A week's points built from a man's opportunities times his per-touch
 * rates, rather than from a model anchored to his season.
 *
 * Usage is his own recent workload per game, mixed with his previous
 * season while he has fewer than three games behind him. Rates come from
 * the same history, shrunk toward the league average for his position, so
 * a back with three carries reads as an average back instead of as those
 * three carries.
 *
 * The site ships this for weeks 1 to 4, where a season-anchored line has
 * almost nothing of this season to anchor to. From week 5 the ridge model
 * takes over. scripts/README.md has the bench that settled the split.
 */

import type { PlayerWeekStats } from "../data/nflverse.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";

/** the last week the component line beats the season-anchored one */
export const COMPONENT_THROUGH_WEEK = 4;

/** how many of a man's own games the trailing window reads */
export const COMPONENT_WINDOW = 4;

/** the positions the component model has priors and rates for */
export const COMPONENT_POSITIONS = ["QB", "RB", "WR", "TE"];

/** the opportunities a projection multiplies a rate by */
export interface Usage {
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

/** what a man did over some stretch, on both sides of usage times rate */
export interface Box extends Usage {
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
export const SHRINK = { passAtt: 80, carries: 40, targets: 30 };

export const emptyBox = (): Box => ({
  passAtt: 0, carries: 0, targets: 0, passYds: 0, passTd: 0,
  interceptions: 0, rushYds: 0, rushTd: 0, receptions: 0, recYds: 0,
  recTd: 0, points: 0,
});

export function boxOf(s: PlayerWeekStats, rules: ScoringRules): Box {
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

export function addBox(into: Box, from: Box): void {
  for (const key of Object.keys(into) as (keyof Box)[]) {
    into[key] += from[key];
  }
}

/** per game over whichever window a caller is reading */
export function perGame(box: Box, count: number): Box {
  if (count <= 0) {
    return emptyBox();
  }

  const out = emptyBox();

  for (const key of Object.keys(out) as (keyof Box)[]) {
    out[key] = box[key] / count;
  }

  return out;
}

export const usageOf = (box: Box): Usage => ({
  passAtt: box.passAtt, carries: box.carries, targets: box.targets,
});

export function scaleUsage(usage: Usage, by: number): Usage {
  return {
    passAtt: usage.passAtt * by,
    carries: usage.carries * by,
    targets: usage.targets * by,
  };
}

export function mixUsage(a: Usage, b: Usage, weight: number): Usage {
  return {
    passAtt: (1 - weight) * a.passAtt + weight * b.passAtt,
    carries: (1 - weight) * a.carries + weight * b.carries,
    targets: (1 - weight) * a.targets + weight * b.targets,
  };
}

/**
 * Points from a man's opportunities and his rates, under the league's
 * rules. This is the whole component model in one place, so a candidate
 * differs only in where its usage and its rates come from.
 */
export function pointsFrom(
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

export function ratesFrom(box: Box, prior: Rates, shrink = SHRINK): Rates {
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
export function rawRates(box: Box, prior: Rates): Rates {
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

/** everything about a man the component line is allowed to look at */
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
 * purpose: scaling a man's touches by his side's implied total cost a
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

/** what a man's own history says his rates are, prior season included */
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
 * Each man's trailing window and previous season as of one week. `stats`
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

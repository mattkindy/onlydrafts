/**
 * Where a week's score puts a man among the men a manager could have
 * started at his position.
 *
 * Both lines are read off what was really scored in the training
 * seasons rather than picked as round numbers. The boom line is what it took to
 * finish top five at quarterback or tight end and top twelve at back or
 * receiver, which is the finish that wins a week. The bust line is
 * replacement level: the best man at the position nobody in a twelve
 * team league started, so finishing under it means the waiver wire
 * would have done as well. Twenty points is a poor week for a
 * quarterback and a huge one for a tight end, so a flat threshold
 * cannot be compared across positions. These can.
 */

import { replacementLevels, DEFAULT_SLOTS, type StarterSlots } from "./replacement.js";
import { loadPlayerStats } from "../data/nflverse.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";

/** how many at a position finish a week high enough to win it for you */
export const BOOM_RANK: Record<string, number> = {
  QB: 5, RB: 12, WR: 12, TE: 5,
};

export interface WeeklyScore {
  position: string;
  points: number;
}

export interface WeeklyLines {
  /** points needed to finish that high, by position */
  boom: Record<string, number>;
  /** points at or below which the waiver wire would have done as well */
  bust: Record<string, number>;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * A typical week's lines, from many weeks as they were scored. Each week
 * gives one reading and the middle one is kept, so a single shootout
 * week does not set the bar for the season.
 */
export function weeklyLines(
  weeks: WeeklyScore[][],
  slots: StarterSlots = DEFAULT_SLOTS,
): WeeklyLines {
  const boomEach: Record<string, number[]> = {};
  const bustEach: Record<string, number[]> = {};

  for (const week of weeks) {
    const { levels } = replacementLevels(
      week.map((m) => ({ position: m.position, ppg: m.points })),
      slots,
    );

    for (const position of Object.keys(BOOM_RANK)) {
      const scores = week
        .filter((m) => m.position === position)
        .map((m) => m.points)
        .sort((a, b) => b - a);
      const rank = BOOM_RANK[position]!;

      if (scores.length >= rank) {
        boomEach[position] = [...(boomEach[position] ?? []), scores[rank - 1]!];
      }

      bustEach[position] = [...(bustEach[position] ?? []), levels[position] ?? 0];
    }
  }

  const boom: Record<string, number> = {};
  const bust: Record<string, number> = {};

  for (const position of Object.keys(BOOM_RANK)) {
    boom[position] = median(boomEach[position] ?? []);
    bust[position] = median(bustEach[position] ?? []);
  }

  return { boom, bust };
}

/** the lines these seasons were scored under, week by week */
export async function linesFor(
  seasons: number[],
  rules: ScoringRules,
  slots: StarterSlots = DEFAULT_SLOTS,
): Promise<WeeklyLines> {
  const byWeek = new Map<string, WeeklyScore[]>();

  for (const season of seasons) {
    for (const s of await loadPlayerStats(season)) {
      if (s.week > 18 || BOOM_RANK[s.position] === undefined) {
        continue;
      }

      const key = `${season}|${s.week}`;
      byWeek.set(key, [
        ...(byWeek.get(key) ?? []),
        { position: s.position, points: fantasyPoints(s.statLine, rules) },
      ]);
    }
  }

  return weeklyLines([...byWeek.values()], slots);
}

/**
 * How often the walk's dealt games cleared the boom line and how often
 * they finished at or under the bust line.
 */
export function chancesFrom(
  dealt: number[],
  lines: WeeklyLines,
  position: string,
): { boomChance: number; bustChance: number } | undefined {
  if (dealt.length === 0 || lines.boom[position] === undefined) {
    return undefined;
  }

  const share = (kept: (points: number) => boolean) =>
    dealt.filter(kept).length / dealt.length;

  return {
    boomChance: share((points) => points >= lines.boom[position]!),
    bustChance: share((points) => points <= lines.bust[position]!),
  };
}

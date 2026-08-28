/**
 * What the man throwing it is worth, as a lift on his side's throws.
 *
 * The walk's passer is a name: his receivers' pools do the work, and a
 * pool shared with last year's passer says nothing about this one.
 * Accuracy alone ranked the checkdown artists above the stars, so the
 * measure is adjusted net yards an attempt, which pays a touchdown,
 * fines a pick, and counts the sacks: the one number that prices a
 * whole throw.
 *
 * The lift multiplies what a pass play gains, on top of everything the
 * pools already know, so it is kept small and pulled well back.
 */

import { loadPlayerStats } from "../data/nflverse.js";

/** how far a clearly better passer moves a throw, either way at most */
const REACH = Number(process.env["PASSER_REACH"] ?? 0.05);
/** a season of throws before his rates speak for themselves */
const SETTLES_AT = 300;
/** how much of the gap to the middle a throw actually keeps */
const KEEPS = Number(process.env["PASSER_KEEPS"] ?? 0.5);

export type PasserLift = (passerId: string) => number;

export async function fitPasserQuality(before: number[]): Promise<PasserLift> {
  const of = new Map<string, {
    yards: number; tds: number; picks: number; sackYds: number;
    attempts: number; sacks: number;
  }>();

  for (const season of before.slice(-2)) {
    for (const s of await loadPlayerStats(season)) {
      if (s.position !== "QB" || s.passing.attempts <= 0) {
        continue;
      }

      const so = of.get(s.playerId) ?? {
        yards: 0, tds: 0, picks: 0, sackYds: 0, attempts: 0, sacks: 0,
      };
      so.yards += s.statLine.passYds;
      so.tds += s.statLine.passTd;
      so.picks += s.statLine.interceptions;
      so.attempts += s.passing.attempts;
      so.sacks += s.passing.sacksTaken;
      of.set(s.playerId, so);
    }
  }

  const anya = (m: { yards: number; tds: number; picks: number;
    attempts: number; sacks: number }) =>
    (m.yards + 20 * m.tds - 45 * m.picks - 6 * m.sacks) /
    Math.max(1, m.attempts + m.sacks);

  const settled = [...of.values()].filter((m) => m.attempts >= 100);
  const middle = settled.reduce((s, m) => s + anya(m), 0) /
    Math.max(1, settled.length);

  return (passerId) => {
    const his = of.get(passerId);

    if (!his || his.attempts < 30) {
      return 1;
    }

    const trust = his.attempts / (his.attempts + SETTLES_AT);
    // a yard an attempt of quality is worth about that share of every
    // throw, against a middle near six
    const better = KEEPS * trust * (anya(his) - middle) / middle;

    return Math.max(1 - REACH, Math.min(1 + REACH, 1 + better));
  };
}

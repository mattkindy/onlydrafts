/**
 * A quarterback's stat line comes from one model over the parts of his
 * play, rather than from the regression the rest of the board uses.
 *
 * Marked on 2024 and 2025 against the regression the board shipped, the
 * joint line wins passers both seasons, 3.8 and 4.0 points of error
 * against 4.2 and 4.7, with everything else split, so the passers move
 * and the other positions keep the regression's line.
 */

import { loadPlayerStats } from "../data/nflverse.js";
import { partsIn } from "../data/advancedParts.js";
import {
  fitJointLine,
  LINE_PARTS,
  type LinePart,
  type Parts,
} from "./jointParts.js";
import { pointsOfLine } from "./inSeasonParts.js";
import type { StatParts } from "./seasonSummary.js";

/** a board player, as much of one as this needs */
export interface PasserBoardPlayer {
  playerId: string;
  position: string;
  projectedPpg: number;
  projectedParts?: StatParts;
}

/** moves every quarterback on the board onto the joint line, in place */
export async function takePasserLines(
  players: PasserBoardPlayer[],
  season: number,
): Promise<number> {
  const learn: {
    parts: Parts; position: string; line: Record<LinePart, number>;
  }[] = [];

  for (let year = 2018; year < season - 1; year++) {
    const before = await partsIn(year);
    const after = new Map<string, {
      games: number; line: Record<LinePart, number>;
    }>();
    const isQb = new Set<string>();

    for (const s of await loadPlayerStats(year + 1)) {
      if (s.week > 18) {
        continue;
      }

      if (s.position === "QB") {
        isQb.add(s.playerId);
      }

      const so = after.get(s.playerId) ?? {
        games: 0,
        line: Object.fromEntries(LINE_PARTS.map((p) => [p, 0])) as
          Record<LinePart, number>,
      };
      so.games++;
      so.line.passYds += s.statLine.passYds;
      so.line.passTd += s.statLine.passTd;
      so.line.interceptions += s.statLine.interceptions;
      so.line.rushYds += s.statLine.rushYds;
      so.line.rushTd += s.statLine.rushTd;
      so.line.receptions += s.statLine.receptions;
      so.line.recYds += s.statLine.recYds;
      so.line.recTd += s.statLine.recTd;
      so.line.passAtt += s.passing.attempts;
      so.line.passCmp += s.passing.completions;
      so.line.carries += s.carries;
      so.line.targets += s.targets;
      after.set(s.playerId, so);
    }

    for (const [who, his] of before) {
      const next = after.get(who);

      if (!next || next.games < 6 || his.games < 4 || !isQb.has(who)) {
        continue;
      }

      learn.push({
        parts: his,
        position: "QB",
        line: Object.fromEntries(LINE_PARTS.map((p) =>
          [p, next.line[p] / next.games])) as Record<LinePart, number>,
      });
    }
  }

  if (learn.length < 60) {
    return 0;
  }

  const fitted = fitJointLine(learn);
  const lastYear = await partsIn(season - 1);
  let taken = 0;

  for (const p of players) {
    if (p.position !== "QB") {
      continue;
    }

    const his = lastYear.get(p.playerId);

    if (!his || his.games < 4) {
      continue;
    }

    const line = fitted.says(his, "QB") as unknown as StatParts;
    p.projectedParts = line;
    p.projectedPpg = pointsOfLine(line);
    taken++;
  }

  return taken;
}

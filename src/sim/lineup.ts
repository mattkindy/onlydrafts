/**
 * Setting a lineup: fill the required slots with the highest scores at
 * each position, then give the flex to the best skill player left over.
 * A policy expresses itself through the scores handed in, so the same
 * setter serves a projection, a season average, or perfect hindsight.
 *
 * Two formats are named below because the simulator and the weekly
 * evaluation disagree about how many receivers a team starts.
 */

export interface LineupCandidate {
  playerId: string;
  position: string;
  score: number;
}

export interface LineupFormat {
  /** how many of each position must start */
  required: Record<string, number>;
  /** which positions may take a flex slot */
  flexPositions: readonly string[];
  flexCount: number;
}

/** one QB, two RB, two WR, one TE, one flex */
export const TWO_RECEIVER_FORMAT: LineupFormat = {
  required: { QB: 1, RB: 2, WR: 2, TE: 1 },
  flexPositions: ["RB", "WR", "TE"],
  flexCount: 1,
};

/** one QB, two RB, three WR, one TE, one flex, which most leagues start */
export const THREE_RECEIVER_FORMAT: LineupFormat = {
  required: { QB: 1, RB: 2, WR: 3, TE: 1 },
  flexPositions: ["RB", "WR", "TE"],
  flexCount: 1,
};

export function startersNeeded(format: LineupFormat): number {
  return (
    Object.values(format.required).reduce((sum, n) => sum + n, 0) +
    format.flexCount
  );
}

export function pickLineup(
  candidates: LineupCandidate[],
  format: LineupFormat = TWO_RECEIVER_FORMAT,
): string[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const flex = new Set(format.flexPositions);
  const filled: Record<string, number> = {};
  const starters: string[] = [];
  const leftovers: LineupCandidate[] = [];

  for (const candidate of sorted) {
    const need = format.required[candidate.position] ?? 0;

    if ((filled[candidate.position] ?? 0) < need) {
      filled[candidate.position] = (filled[candidate.position] ?? 0) + 1;
      starters.push(candidate.playerId);
    } else {
      leftovers.push(candidate);
    }
  }

  let flexUsed = 0;

  for (const candidate of leftovers) {
    if (flexUsed >= format.flexCount) {
      break;
    }

    if (flex.has(candidate.position)) {
      starters.push(candidate.playerId);
      flexUsed++;
    }
  }

  return starters;
}

/**
 * Standard lineup: one QB, two RB, two WR, one TE, one flex from
 * RB/WR/TE. A policy expresses itself through the scores handed in;
 * required slots fill greedily, then flex takes the best skill leftover.
 */

export interface LineupCandidate {
  playerId: string;
  position: string;
  score: number;
}

const REQUIRED: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1 };
const FLEX_POSITIONS = new Set(["RB", "WR", "TE"]);
const FLEX_COUNT = 1;

export function pickLineup(candidates: LineupCandidate[]): string[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const filled: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const starters: string[] = [];
  const leftovers: LineupCandidate[] = [];

  for (const candidate of sorted) {
    const need = REQUIRED[candidate.position] ?? 0;

    if ((filled[candidate.position] ?? 0) < need) {
      filled[candidate.position] = (filled[candidate.position] ?? 0) + 1;
      starters.push(candidate.playerId);
    } else {
      leftovers.push(candidate);
    }
  }

  let flexUsed = 0;

  for (const candidate of leftovers) {
    if (flexUsed >= FLEX_COUNT) {
      break;
    }

    if (FLEX_POSITIONS.has(candidate.position)) {
      starters.push(candidate.playerId);
      flexUsed++;
    }
  }

  return starters;
}

/**
 * Start/sit scoring: take every pair of men you could have chosen between
 * and ask how often the one a method ranked higher outscored the other.
 *
 * This is the question a manager actually asks on Sunday morning, and it
 * is not the same as a slate-wide rank correlation. A method can order a
 * whole position well and still lose the two-man calls that were close.
 * Pairs are bucketed by how far apart the two projections were, because
 * a method that only wins the blowout calls has told you nothing.
 *
 * A pair where the two projections are identical is left out, since no
 * call was made. A pair where both men scored the same counts as half.
 */

export interface PairEntry {
  predicted: number;
  actual: number;
}

export interface PairTally {
  right: number;
  total: number;
}

export interface GapBucket {
  name: string;
  min: number;
  max: number;
}

export const PAIR_GAPS: readonly GapBucket[] = [
  { name: "0-2", min: 0, max: 2 },
  { name: "2-5", min: 2, max: 5 },
  { name: "5+", min: 5, max: Infinity },
  { name: "all", min: 0, max: Infinity },
];

export function emptyTally(): Map<string, PairTally> {
  return new Map(PAIR_GAPS.map((g) => [g.name, { right: 0, total: 0 }]));
}

/** every pair within one group, added into a tally shared across groups */
export function addPairs(
  tally: Map<string, PairTally>,
  entries: PairEntry[],
): void {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      const gap = Math.abs(a.predicted - b.predicted);

      if (gap === 0) {
        continue;
      }

      const higher = a.predicted > b.predicted ? a : b;
      const lower = a.predicted > b.predicted ? b : a;
      const credit = creditFor(higher.actual, lower.actual);

      for (const bucket of PAIR_GAPS) {
        if (gap < bucket.min || gap >= bucket.max) {
          continue;
        }

        const cell = tally.get(bucket.name)!;
        cell.right += credit;
        cell.total += 1;
      }
    }
  }
}

function creditFor(higherActual: number, lowerActual: number): number {
  if (higherActual > lowerActual) {
    return 1;
  }

  if (higherActual === lowerActual) {
    return 0.5;
  }

  return 0;
}

export function pairRate(tally: Map<string, PairTally>, gap: string): number {
  const cell = tally.get(gap);

  if (!cell || cell.total === 0) {
    return NaN;
  }

  return cell.right / cell.total;
}

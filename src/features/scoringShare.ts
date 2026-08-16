/**
 * A player's share of his team's touchdowns, for the generative model.
 *
 * Which measure predicts next season best turns out to depend on the
 * position, measured over 493 player-season pairs from 2021 to 2025:
 *
 *   backs        chances inside the twenty    .363 against .331 for scores
 *   receivers    last season's scores         .320 against .284 for chances
 *   tight ends   targets inside the twenty    .373 against .151 for scores
 *
 * Combining all four measures in a ridge was worse than the best one
 * alone at every position, so each takes the one that suits it.
 */

export interface RedZoneUse {
  /** targets and hand-offs he took inside the twenty */
  redTargets: number;
  redCarries: number;
  /** hand-offs inside the five */
  goalCarries: number;
  /** touchdowns he actually scored */
  scores: number;
  teamRedTargets: number;
  teamRedCarries: number;
  teamGoalCarries: number;
  teamScores: number;
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** how much of his team's scoring to expect from him */
export function scoringShare(position: string, use: RedZoneUse): number {
  if (position === "RB") {
    return share(
      use.redTargets + use.redCarries,
      use.teamRedTargets + use.teamRedCarries,
    );
  }

  if (position === "TE") {
    return share(use.redTargets, use.teamRedTargets);
  }

  return share(use.scores, use.teamScores);
}

/** which measure a position uses, for anyone reading the numbers */
export function scoringShareBasis(position: string): string {
  if (position === "RB") return "chances inside the twenty";
  if (position === "TE") return "targets inside the twenty";
  return "last season's touchdowns";
}

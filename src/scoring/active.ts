import { presets, type ScoringRules } from "./fantasyPoints.js";

/**
 * The scoring a run uses. Projections are only meaningful in one
 * league's rules, so scripts set this once at startup and every
 * feature builder reads it.
 */
let current: ScoringRules = presets.ppr;

export function setScoring(rules: ScoringRules): void {
  current = rules;
}

export function scoring(): ScoringRules {
  return current;
}

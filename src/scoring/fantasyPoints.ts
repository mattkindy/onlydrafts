export interface StatLine {
  passYds: number;
  passTd: number;
  interceptions: number;
  rushYds: number;
  rushTd: number;
  receptions: number;
  recYds: number;
  recTd: number;
  fumblesLost: number;
  twoPointConversions: number;
}

/** Points per unit of each stat. A league's scoring settings, flattened. */
export type ScoringRules = Record<keyof StatLine, number>;

export type ScoringFormat = "standard" | "half" | "ppr";

const base: Omit<ScoringRules, "receptions"> = {
  passYds: 0.04,
  passTd: 4,
  interceptions: -2,
  rushYds: 0.1,
  rushTd: 6,
  recYds: 0.1,
  recTd: 6,
  fumblesLost: -2,
  twoPointConversions: 2,
};

export const presets: Record<ScoringFormat, ScoringRules> = {
  standard: { ...base, receptions: 0 },
  half: { ...base, receptions: 0.5 },
  ppr: { ...base, receptions: 1 },
};

/** A preset with any of its weights overridden, e.g. 6-point passing TDs. */
export function scoringRules(
  format: ScoringFormat,
  overrides: Partial<ScoringRules> = {},
): ScoringRules {
  return { ...presets[format], ...overrides };
}

export function fantasyPoints(line: StatLine, rules: ScoringRules): number {
  let total = 0;

  for (const stat of Object.keys(rules) as (keyof StatLine)[]) {
    total += line[stat] * rules[stat];
  }

  return Math.round(total * 100) / 100;
}

export function emptyStatLine(): StatLine {
  return {
    passYds: 0,
    passTd: 0,
    interceptions: 0,
    rushYds: 0,
    rushTd: 0,
    receptions: 0,
    recYds: 0,
    recTd: 0,
    fumblesLost: 0,
    twoPointConversions: 0,
  };
}

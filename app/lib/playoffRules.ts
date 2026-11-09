/**
 * How a league decides who makes its playoffs: how many get in, what
 * the teams are ranked by, whether each division's winner gets in ahead
 * of the rest, and what settles two teams the ranking cannot tell apart.
 *
 * The league's own settings fill in what the provider says, and the
 * reader can change any of it, kept per league.
 */

/** what the table is ranked by */
export type SeedBy = "wins" | "median" | "allplay" | "pf";

/** what settles a tie in the ranking, tried in order */
export type Tiebreak = "h2h" | "pf" | "paMost" | "paFewest" | "allplay" | "division" | "wins";

export interface PlayoffRules {
  /** how many teams make it */
  teams: number;
  seedBy: SeedBy;
  /** tried in order; a tie through all of them is a coin flip */
  ties: Tiebreak[];
  /** whether each division's winner gets in, the rest as wild cards */
  divisions: boolean;
}

export const SEED_SAYS: Record<SeedBy, string> = {
  wins: "record",
  median: "record + median",
  allplay: "all-play",
  pf: "points for",
};

export const TIE_SAYS: Record<Tiebreak, string> = {
  h2h: "head-to-head",
  pf: "points for",
  paMost: "most PA",
  paFewest: "fewest PA",
  allplay: "all-play",
  division: "division record",
  wins: "record",
};

const SEEDS = Object.keys(SEED_SAYS) as SeedBy[];
const TIES = Object.keys(TIE_SAYS) as Tiebreak[];

interface LeagueSays {
  provider: string;
  leagueId: string;
  size: number;
  playoffTeams?: number | null;
  divisions?: { id: number; name: string }[] | null;
  medianGame?: boolean | null;
  seedTiebreak?: Tiebreak | null;
}

/** what the league's own settings say, with points for after any tiebreaker it names */
export function leagueRules(league: LeagueSays): PlayoffRules {
  const first = league.seedTiebreak ?? null;

  return {
    teams: league.playoffTeams ?? (league.size >= 12 ? 6 : 4),
    seedBy: league.medianGame ? "median" : "wins",
    ties: first && first !== "pf" ? [first, "pf"] : ["pf"],
    divisions: (league.divisions?.length ?? 0) > 1,
  };
}

/** where a league's rules are kept */
export const rulesKey = (league: LeagueSays) =>
  "rules." + league.provider + "." + league.leagueId;

/**
 * Rules read back from storage, kept only where they still make sense:
 * a stored value from an older page, or a hand edit, falls back to the
 * league's own setting field by field.
 */
export function readRules(saved: unknown, league: LeagueSays): PlayoffRules {
  const own = leagueRules(league);

  if (!saved || typeof saved !== "object") {
    return own;
  }

  const said = saved as Partial<Record<keyof PlayoffRules, unknown>>;
  const teams = Number(said.teams);
  const ties = Array.isArray(said.ties)
    ? [...new Set(said.ties.filter((t): t is Tiebreak => TIES.includes(t as Tiebreak)))]
    : own.ties;

  return {
    teams: Number.isInteger(teams) && teams >= 1 && teams <= league.size ? teams : own.teams,
    seedBy: SEEDS.includes(said.seedBy as SeedBy) ? said.seedBy as SeedBy : own.seedBy,
    ties,
    divisions: typeof said.divisions === "boolean"
      ? said.divisions && (league.divisions?.length ?? 0) > 1
      : own.divisions,
  };
}

/** who gets in, in a line, for the playoff list and its picture */
export function rulesSay(rules: PlayoffRules, divisions: number): string {
  const wild = rules.teams - divisions;
  const who = rules.divisions && divisions > 1
    ? `${divisions} division winners + ${wild} wild card${wild === 1 ? "" : "s"}`
    : `top ${rules.teams} make it`;

  return rules.seedBy === "wins" ? who : `${who}, by ${SEED_SAYS[rules.seedBy]}`;
}

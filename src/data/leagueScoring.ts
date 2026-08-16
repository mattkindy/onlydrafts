import { presets, type ScoringRules } from "../scoring/fantasyPoints.js";
import type { StarterSlots } from "../features/replacement.js";

/**
 * A league's scoring, read from Sleeper so projections match the rules
 * they will be judged by. Anything the league does not define falls
 * back to the standard value.
 */
export async function fetchLeagueScoring(
  leagueId: string,
): Promise<ScoringRules> {
  const league = (await fetch(
    "https://api.sleeper.app/v1/league/" + leagueId,
  ).then((r) => r.json())) as { scoring_settings?: Record<string, number> };
  const s = league.scoring_settings ?? {};
  const base = presets.standard;

  return {
    passYds: s["pass_yd"] ?? base.passYds,
    passTd: s["pass_td"] ?? base.passTd,
    interceptions: s["pass_int"] ?? base.interceptions,
    rushYds: s["rush_yd"] ?? base.rushYds,
    rushTd: s["rush_td"] ?? base.rushTd,
    receptions: s["rec"] ?? base.receptions,
    recYds: s["rec_yd"] ?? base.recYds,
    recTd: s["rec_td"] ?? base.recTd,
    fumblesLost: s["fum_lost"] ?? base.fumblesLost,
    twoPointConversions: s["rec_2pt"] ?? base.twoPointConversions,
  };
}

/**
 * The lineup a league starts, read from Sleeper. Flex slots stay
 * separate from dedicated ones so replacement level can fill them from
 * whichever position is deeper instead of splitting them by a guess.
 */
export async function fetchStarterSlots(
  leagueId: string,
): Promise<StarterSlots> {
  const league = (await fetch(
    "https://api.sleeper.app/v1/league/" + leagueId,
  ).then((r) => r.json())) as {
    roster_positions?: string[];
    total_rosters?: number;
  };
  const slots: StarterSlots = {
    teams: league.total_rosters ?? 12,
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
    flex: 0,
    superFlex: 0,
  };

  for (const slot of league.roster_positions ?? []) {
    if (slot === "FLEX" || slot === "REC_FLEX" || slot === "WRRB_FLEX") {
      slots.flex++;
    } else if (slot === "SUPER_FLEX" || slot === "QB_FLEX") {
      slots.superFlex++;
    } else if (slot === "QB" || slot === "RB" || slot === "WR" || slot === "TE") {
      slots[slot]++;
    }
  }

  return slots;
}

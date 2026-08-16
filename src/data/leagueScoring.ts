import { presets, type ScoringRules } from "../scoring/fantasyPoints.js";

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
 * How many starters the league actually plays at each position, flex
 * slots included. Replacement level comes right after this line, which
 * is what makes value over replacement mean anything in a league.
 */
export async function fetchStarterCounts(
  leagueId: string,
): Promise<Record<string, number>> {
  const league = (await fetch(
    "https://api.sleeper.app/v1/league/" + leagueId,
  ).then((r) => r.json())) as {
    roster_positions?: string[];
    total_rosters?: number;
  };
  const teams = league.total_rosters ?? 12;
  const slots = league.roster_positions ?? [];
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  let flex = 0;
  let superFlex = 0;

  for (const slot of slots) {
    if (slot === "FLEX" || slot === "REC_FLEX" || slot === "WRRB_FLEX") {
      flex++;
    } else if (slot === "SUPER_FLEX" || slot === "QB_FLEX") {
      superFlex++;
    } else if (slot === "QB" || slot === "RB" || slot === "WR" || slot === "TE") {
      counts[slot]++;
    }
  }

  // flex slots go mostly to backs and receivers, the way lineups fill
  counts.RB += flex * 0.45;
  counts.WR += flex * 0.45;
  counts.TE += flex * 0.1;
  counts.QB += superFlex * 0.8;
  counts.RB += superFlex * 0.1;
  counts.WR += superFlex * 0.1;

  return {
    QB: Math.round(counts.QB * teams),
    RB: Math.round(counts.RB * teams),
    WR: Math.round(counts.WR * teams),
    TE: Math.round(counts.TE * teams),
  };
}

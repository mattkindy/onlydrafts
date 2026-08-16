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

/**
 * Where to go to act on what the page says.
 *
 * Neither provider lets a page like this one change a lineup: Sleeper's
 * public API only reads, and ESPN's writes are private endpoints behind
 * your sign-in. So the page says what to do and then opens the
 * provider's own page for doing it, which on a phone with the provider's
 * app installed is usually the app.
 */

import type { League } from "./providers.ts";

export const PROVIDER_NAME: Record<League["provider"], string> = {
  sleeper: "Sleeper",
  espn: "ESPN",
};

/** your team's page, where the lineup is set */
export function lineupLink(league: League): string {
  if (league.provider === "espn") {
    return "https://fantasy.espn.com/football/team?leagueId=" +
      encodeURIComponent(league.leagueId) + "&teamId=" +
      encodeURIComponent(league.userId) + "&seasonId=" + league.season;
  }

  return `https://sleeper.com/leagues/${encodeURIComponent(league.leagueId)}/team`;
}

/** the league's free agents, where a claim or an add is made */
export function playersLink(league: League): string {
  if (league.provider === "espn") {
    return "https://fantasy.espn.com/football/players/add?leagueId=" +
      encodeURIComponent(league.leagueId) + "&seasonId=" + league.season;
  }

  return `https://sleeper.com/leagues/${encodeURIComponent(league.leagueId)}/players`;
}

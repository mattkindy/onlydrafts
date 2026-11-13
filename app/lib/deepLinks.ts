/**
 * Where to go to act on what the page says.
 *
 * Neither provider lets a page like this one change a lineup: Sleeper's
 * public API only reads, and ESPN's writes are private endpoints behind
 * your sign-in. So the page says what to do and then opens the
 * provider's own page for doing it.
 *
 * Whether a phone hands that page to the provider's app is the app's own
 * say, published on its site. ESPN's iPhone app takes the team page and
 * the free agents page: fantasy.espn.com/.well-known/apple-app-site-association
 * lists the team and players/add paths of every sport. Sleeper's iPhone app takes only
 * its chat links, so a league page always opens in the browser there.
 *
 * On Android Sleeper's app opens for a link to its site but always on
 * its own home screen, whatever page the link names: tried on a phone
 * with the plain league page, sleeper.app, three sleeper:// addresses
 * and two intent links, all eight landing on the home screen. A link
 * addressed to the app with a web fallback once sent a reader to the
 * Play Store instead. So every link is the plain web page, which opens
 * Sleeper's app where it is installed and the page where it is not.
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

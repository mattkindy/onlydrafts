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
 * Android is the same: an app opens a plain link to its site when it
 * takes that page, and Sleeper's does not take a league page. A link
 * addressed to the Sleeper app itself (an intent link) was tried and
 * sent the reader to the Play Store, since a browser cannot open an app
 * at a page it does not take. So every link is the plain web page, and
 * a Sleeper page works once the reader is signed in to sleeper.com in
 * that browser.
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

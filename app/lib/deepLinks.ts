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
 * On Android both apps are registered for their sites, and a link can be
 * addressed to the app itself, so there the page goes to the app.
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

/**
 * Each provider's Android app, as its site's assetlinks.json names it.
 */
const ANDROID_APP: Record<string, string> = {
  "sleeper.com": "com.sleeperbot",
  "fantasy.espn.com": "com.espn.fantasy.lm.football",
};

/**
 * The same page addressed to the provider's Android app, so it opens
 * there rather than in a browser that is not signed in. Where the app is
 * not installed, or does not take that page, the phone opens the page on
 * the web instead. Null for a page no app is known for.
 */
export function androidAppLink(url: string): string | null {
  let page: URL;

  try {
    page = new URL(url);
  } catch {
    return null;
  }

  const app = ANDROID_APP[page.hostname];

  if (!app || page.protocol !== "https:") {
    return null;
  }

  return `intent://${page.host}${page.pathname}${page.search}` +
    `#Intent;scheme=https;package=${app};` +
    `S.browser_fallback_url=${encodeURIComponent(url)};end`;
}

/** whether this is an Android phone or tablet */
export const onAndroid = (
  agent = typeof navigator === "undefined" ? "" : navigator.userAgent,
) => /Android/i.test(agent);

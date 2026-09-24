/**
 * The board's key, team code and position for a player a provider named.
 *
 * Every page looks a player up by the board's key: the slate, the injury
 * list, the lineups and the draft. Sleeper and ESPN spell some players
 * and teams differently from the board, so everything a provider hands
 * over goes through here first. A player missing from these tables scores
 * nothing and shows as a free agent, so a new mismatch belongs here rather
 * than in a table of its own somewhere else.
 */

import { normalizeName } from "./store.ts";

/**
 * A provider's or ESPN's scoreboard code for a team against the board's.
 * Everything else already matches, including JAX.
 */
const SAME_SIDE: Record<string, string> = { WSH: "WAS", LAR: "LA" };

/** ESPN's number for each pro team, in the board's codes */
export const ESPN_TEAMS: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LA",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA",
  27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

/**
 * Players the providers spell differently from the board, normalized
 * spelling to the board's key. The board goes by the league's roster
 * name, so Joshua Palmer is joshpalmer there while ESPN and Sleeper
 * both write him out in full, and Marquise Brown goes by Hollywood on
 * ESPN. Found by matching a league's picks and a week's slate against
 * Sleeper's player file.
 */
const SAME_MAN: Record<string, string> = {
  joshuapalmer: "joshpalmer",
  hollywoodbrown: "marquisebrown",
  drewogletree: "andrewogletree",
  matthibner: "matthewhibner",
  mitchtinsley: "mitchelltinsley",
  scottymiller: "scottmiller",
  zonovanknight: "bamknight",
  deamontetrayanum: "chiptrayanum",
  joshuapitsenberger: "joshpitsenberger",
};

/**
 * Positions a provider uses that the board folds into another. Sleeper
 * lists a fullback as FB, and the board counts him as a back.
 */
const SAME_ROLE: Record<string, string> = { FB: "RB" };

/** players a provider lists at a position the board does not, by board key */
const PLAYS_AS: Record<string, string> = { djherman: "RB" };

/** the board's code for a team, whoever wrote it */
export function boardTeamOf(code: string): string {
  const upper = code.toUpperCase();

  return SAME_SIDE[upper] ?? upper;
}

/**
 * The board's key for a player. A defence goes by its team code, since
 * Sleeper gives one no name and ESPN calls it "Rams D/ST".
 */
export function boardKeyOf(
  name: string, position: string | undefined, team?: string | null,
): string {
  if (position === "DEF") {
    return normalizeName(boardTeamOf(team || name));
  }

  const key = normalizeName(name);

  return SAME_MAN[key] ?? key;
}

/** the position the board has a player at, from the one a provider gave */
export function boardPositionOf(key: string, position: string): string {
  return PLAYS_AS[key] ?? SAME_ROLE[position] ?? position;
}

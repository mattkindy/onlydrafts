/**
 * A man's stat line, said the way a box score says it.
 *
 * The board ships what he does in a game and how each week stands
 * against his own average. A season is the game line times the games he
 * is expected to play, and a week is the game line times that week.
 *
 * There is no weekly line here on purpose. A defence keeps about a fifth of
 * itself from one season to the next, so a week in August cannot be told from the
 * week after it, and printing 115 yards for one and 117 for another
 * would be inventing a difference. A kicker is the exception, and his
 * weeks come from the walk playing each ground.
 */

import type { Parts } from "./scoring.ts";

export interface Figure {
  label: string;
  value: number;
  /** whole numbers for yards, one place for the rest */
  places: number;
}

/** the ones a box score writes as whole numbers */
const WHOLE = new Set(["passYds", "rushYds", "recYds", "fgmYds",
  "passAtt", "passCmp", "carries", "targets"]);

/** what a box score puts next to each thing he did */
const CALLED: Record<string, string> = {
  passCmp: "comp", passAtt: "att", carries: "car", targets: "tgt",
  passYds: "pass yds", passTd: "pass td", interceptions: "int",
  rushYds: "rush yds", rushTd: "rush td",
  receptions: "rec", recYds: "rec yds", recTd: "rec td",
  fumblesLost: "fum", twoPointConversions: "2pt",
  fgmYds: "fg yds", xpm: "xp", xpmiss: "xp miss",
  fgm: "fg", fgmiss: "fg miss",
  sack: "sack", int: "int", fum_rec: "fum rec", def_td: "td",
  safe: "safety", blk_kick: "block",
};

/** the few worth showing for each position, in the order a box score has them */
const HEADLINE: Record<string, string[]> = {
  QB: ["passCmp", "passAtt", "passYds", "passTd", "interceptions",
    "carries", "rushYds", "rushTd"],
  RB: ["carries", "rushYds", "rushTd", "targets", "receptions", "recYds", "recTd"],
  WR: ["targets", "receptions", "recYds", "recTd", "carries", "rushYds", "rushTd"],
  TE: ["targets", "receptions", "recYds", "recTd"],
  K: ["fgm", "fgmYds", "xpm", "fgmiss"],
  DEF: ["sack", "int", "fum_rec", "def_td", "safe", "blk_kick"],
};

/**
 * His line over however many games, with the categories his position is
 * read by and nothing he never does.
 *
 * Scaled by however far the board moved him off his own projection, so
 * the line and the points beside it are the same claim. Without that
 * Bijan Robinson reads 117 rushing yards a game against 21.1 points,
 * and 117 yards is not 21.1 points in anybody's league.
 */
export function lineOver(
  parts: Parts | null | undefined,
  position: string,
  games: number,
  moved = 1,
): Figure[] {
  if (!parts) {
    return [];
  }

  const wanted = HEADLINE[position] ?? HEADLINE["WR"]!;

  return wanted
    .map((part) => ({
      label: CALLED[part] ?? part,
      value: (parts[part] ?? 0) * games * moved,
      places: WHOLE.has(part) ? 0 : 1,
    }))
    .filter((f) => f.value >= (f.places === 0 ? 0.5 : 0.05));
}

/** how far the board moved him off what his own projection said */
export const movedBy = (p: { ppg?: number; ownPpg?: number }) =>
  p.ownPpg && p.ownPpg > 0 ? (p.ppg ?? 0) / p.ownPpg : 1;

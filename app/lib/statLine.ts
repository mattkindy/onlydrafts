/**
 * A man's stat line, said the way a box score says it.
 *
 * The board ships what he does in a game and how each week stands
 * against his own average. A season is the game line times the games he
 * is expected to play, and a week is the game line times that week.
 *
 * A week moves every category together. The weekly model was fitted on
 * points, so it knows a hard matchup costs him a tenth and not whether
 * that tenth comes off his catches or his yards.
 */

import type { Parts } from "./scoring.ts";

export interface Figure {
  label: string;
  value: number;
  /** whole numbers for yards, one place for the rest */
  places: number;
}

const YARDS = new Set(["passYds", "rushYds", "recYds", "fgmYds"]);

/** what a box score puts next to each thing he did */
const CALLED: Record<string, string> = {
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
  QB: ["passYds", "passTd", "interceptions", "rushYds", "rushTd"],
  RB: ["rushYds", "rushTd", "receptions", "recYds", "recTd"],
  WR: ["receptions", "recYds", "recTd", "rushYds", "rushTd"],
  TE: ["receptions", "recYds", "recTd"],
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
      places: YARDS.has(part) ? 0 : 1,
    }))
    .filter((f) => f.value >= (f.places === 0 ? 0.5 : 0.05));
}

/** the two or three a week is worth showing by, so a row still fits */
export function weekLine(
  parts: Parts | null | undefined,
  position: string,
  of: number,
  moved = 1,
): Figure[] {
  return lineOver(parts, position, of, moved).slice(0, 3);
}

/** how far the board moved him off what his own projection said */
export const movedBy = (p: { ppg?: number; ownPpg?: number }) =>
  p.ownPpg && p.ownPpg > 0 ? (p.ppg ?? 0) / p.ownPpg : 1;

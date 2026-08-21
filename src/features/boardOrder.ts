/**
 * The order a draft board is read in, from three opinions at once.
 *
 * The regression asks what a player did and what changed around him.
 * The share model asks how much of his offence's work he wins against
 * the men competing with him. Adp says where he is being taken. The
 * first two disagree about different players, so mixing both with adp
 * beats mixing either: over 2023 to 2025 on the men adp priced, .568
 * on a season's points against .530 for adp alone and .516 for the
 * regression and adp, and .546 against .492 and .465 on points over
 * the last startable man at the position. It won every season on both.
 */

export interface Opinion {
  /** his place by the season regression, 1 for the best */
  model: number;
  /** his place by projected touches, absent for a quarterback */
  share?: number;
  /** where adp has him, absent if nobody has priced him */
  adp?: number;
  /** his place by the games played out, absent if they never saw him */
  walk?: number;
}

export interface BoardLean {
  model: number;
  share: number;
  adp: number;
  walk: number;
}

/**
 * Swept on a grid rather than fitted, and taken from the middle of the
 * plateau rather than its highest cell. The walk's seat came from its
 * own sweep: fifteen percent improves the blend on both targets and
 * more starts to cost.
 */
export const BOARD_LEAN: BoardLean = {
  model: 0.106, share: 0.319, adp: 0.425, walk: 0.15,
};

/**
 * Quarterbacks are ordered mostly by the walk. Once sampled draws
 * could hear the opponent, the walk alone ordered the position better
 * than adp in all three test seasons (.73, .50 and .47 against .28,
 * .38 and .08), and every mix in between scored between the two. The
 * fifteen percent left with adp and the regression is for what the
 * simulation cannot see at draft time, a benching battle or an
 * injury the market has heard about.
 */
export const QB_LEAN: BoardLean = {
  model: 0.03, share: 0, adp: 0.12, walk: 0.85,
};

export function leanFor(position: string): BoardLean {
  if (position === "QB") {
    return QB_LEAN;
  }

  return BOARD_LEAN;
}

/**
 * Where a player lands, lower being earlier.
 *
 * An opinion with nothing to say about him does not drag him toward
 * the middle: its weight goes to the opinions that do have something.
 * A quarterback competes with nobody for touches, so the share model
 * is silent on him and he lands where the regression and adp put him.
 */
export function blendedPlace(
  opinion: Opinion, lean: BoardLean = BOARD_LEAN,
): number {
  const parts: [number, number][] = [[lean.model, opinion.model]];

  if (opinion.share !== undefined) {
    parts.push([lean.share, opinion.share]);
  }

  if (opinion.adp !== undefined) {
    parts.push([lean.adp, opinion.adp]);
  }

  if (opinion.walk !== undefined) {
    parts.push([lean.walk, opinion.walk]);
  }

  const weight = parts.reduce((sum, [w]) => sum + w, 0);

  return parts.reduce((sum, [w, place]) => sum + w * place, 0) / weight;
}

/** each man's place by one measure, best first */
export function placesBy<T>(
  men: T[], keyOf: (man: T) => string, by: (man: T) => number | null,
): Map<string, number> {
  const ranked = men
    .filter((man) => by(man) !== null)
    .sort((a, b) => by(b)! - by(a)!);

  return new Map(ranked.map((man, i) => [keyOf(man), i + 1]));
}

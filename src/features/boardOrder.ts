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
  /**
   * His place by one model over all the parts of his play, absent for
   * a man with no season behind him.
   *
   * It knows nothing about passing, since the advanced stat files only
   * count carrying and catching, so it never speaks for a quarterback.
   */
  parts?: number;
  /** his place by the season regression, which is what a passer gets */
  model?: number;
  /** his place by projected touches, absent for a quarterback */
  share?: number;
  /** where adp has him, absent if nobody has priced him */
  adp?: number;
  /** his place by the games played out, absent if they never saw him */
  walk?: number;
}

export interface BoardLean {
  parts: number;
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
  parts: 0.106, model: 0, share: 0.319, adp: 0.425, walk: 0.15,
};

/**
 * Quarterbacks are ordered mostly by the walk. The parts model has
 * nothing to say about them, since it cannot see a throw, so the seat
 * it takes for everybody else goes back to the regression here.
 * Once sampled draws
 * could hear the opponent, the walk alone ordered the position better
 * than adp in all three test seasons (.73, .50 and .47 against .28,
 * .38 and .08), and every mix in between scored between the two. The
 * fifteen percent left with adp and the regression is for what the
 * simulation cannot see at draft time, a benching battle or an
 * injury the market has heard about.
 */
export const QB_LEAN: BoardLean = {
  parts: 0, model: 0.03, share: 0, adp: 0.12, walk: 0.85,
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
  const parts: [number, number][] = [];

  if (opinion.parts !== undefined && lean.parts > 0) {
    parts.push([lean.parts, opinion.parts]);
  }

  if (opinion.model !== undefined && lean.model > 0) {
    parts.push([lean.model, opinion.model]);
  }

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

  // nobody had anything to say about him, so he goes to the back
  if (weight === 0) {
    return Number.MAX_SAFE_INTEGER;
  }

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

/**
 * An opinion's places, moved onto the board's own scale.
 *
 * An opinion ranks only the men it can see, so its places run 1 to
 * however many that is. Adding those to another opinion's places only
 * works when both see the same men, and they do not: adp prices the
 * front of the board, the parts model speaks for whoever had a season
 * last year, and those are different shapes.
 *
 * So take the board positions of the men this opinion can see, in
 * order, and hand its best man the first of them, its second the
 * second, and so on. An opinion covering the front of the board comes
 * out unchanged. One covering scattered men gets stretched to match.
 */
export function spreadOver(
  places: Map<string, number>,
  /** where each man sits on the board by something that saw everybody */
  reference: Map<string, number>,
): Map<string, number> {
  const seen = [...places.keys()].filter((key) => reference.has(key));
  const sittingAt = seen
    .map((key) => reference.get(key)!)
    .sort((a, b) => a - b);
  const byPlace = [...seen].sort((a, b) => places.get(a)! - places.get(b)!);

  return new Map(byPlace.map((key, i) => [key, sittingAt[i]!]));
}

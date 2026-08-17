/**
 * A share won against the men competing for it.
 *
 * Giving every second receiver the share a second receiver usually gets
 * treats standing behind Justin Jefferson as the same job as standing
 * behind a journeyman. It also promotes a veteran with a good season
 * behind him onto a roster where he is buried, which is how Nyheim
 * Hines came out 76th and finished 528th.
 *
 * So allocate instead. A position group has a share of its offence to
 * give out, and each man takes a cut of it in proportion to how he
 * compares with the others there.
 */

export interface Contender {
  playerId: string;
  /** what he has shown he is worth, on any scale where more is better */
  standing: number;
}

export interface CompetitionSettings {
  /**
   * How sharply the better man is favoured. At one the work is split in
   * proportion to standing; above one the best of them takes more than
   * his proportion, which is what depth charts do.
   */
  sharpness: number;
  /** what a man with nothing behind him still counts for */
  floor: number;
}

/**
 * Swept over the 2024 season, where the answer came out flat from .9 to
 * 1.0 and fell away either side: .724 at .5, .761 at 1.0, .733 at 3.
 * So the work divides in proportion to what a man has shown, and
 * favouring the better of them beyond that makes it worse.
 */
export const COMPETITION_DEFAULTS: CompetitionSettings = {
  sharpness: 1,
  floor: 0.004,
};

/**
 * How a group's work divides between them.
 *
 * The total is what the position takes of this offence, so the shares
 * add up to it. A man alone at his position takes all of it however
 * little he has shown, which is right: somebody has to play.
 */
export function divideAmong(
  contenders: Contender[],
  total: number,
  settings: CompetitionSettings = COMPETITION_DEFAULTS,
): Map<string, number> {
  const weights = contenders.map((man) =>
    Math.pow(Math.max(settings.floor, man.standing), settings.sharpness),
  );
  const sum = weights.reduce((a, b) => a + b, 0);

  if (sum <= 0) {
    return new Map(
      contenders.map((man) => [man.playerId, total / Math.max(1, contenders.length)]),
    );
  }

  return new Map(
    contenders.map((man, i) => [man.playerId, total * (weights[i]! / sum)]),
  );
}

/**
 * What a man makes once the ball is his.
 *
 * A catch is 6.10 yards of throw and 5.19 after it, near enough half
 * each, and the walk draws the two as one number. They are different
 * skills and both are his: how far he is thrown carries to the next
 * season at .884 and what he makes after the catch at .689, which are
 * the two steadiest things measured on a player here. The depth pools
 * already choose how far he is thrown; this says whether the yards
 * after it are his kind.
 */

export interface AfterCatchRow {
  player: string;
  /** how far downfield it was thrown */
  airYards: number;
  /** and what he made once he had it */
  afterCatch: number;
}

export interface AfterCatch {
  /** what he makes after the catch against what anybody makes, near one */
  leanOf: (player: string) => number;
  /** and how much of a catch is made after it, so only that part moves */
  shareAfter: number;
  learnedFrom: number;
}

/** a man needs this many catches before his own number is believed */
const ENOUGH = 25;
const SETTLES_AT = Number(process.env["YAC_SETTLES"] ?? 60);
/** and how far his own can carry him, since one long run is not a skill */
const MOST = 1.5;

export function fitAfterCatch(rows: AfterCatchRow[]): AfterCatch {
  const his = new Map<string, { n: number; made: number }>();
  const league = new Map<number, { n: number; made: number }>();
  /** by how far it was thrown, since a checkdown leaves more room */
  const bandOf = (air: number) =>
    air < 0 ? 0 : air < 5 ? 1 : air < 10 ? 2 : air < 20 ? 3 : 4;

  for (const row of rows) {
    if (!row.player) {
      continue;
    }

    const band = bandOf(row.airYards);
    const all = league.get(band) ?? { n: 0, made: 0 };
    all.n++;
    all.made += row.afterCatch;
    league.set(band, all);
    const own = his.get(row.player) ?? { n: 0, made: 0 };
    own.n++;
    own.made += row.afterCatch;
    his.set(row.player, own);
  }

  /**
   * His own against what everybody made on the throws he actually
   * got, so a man who lives on checkdowns is not credited with the
   * room they leave him.
   */
  const expected = new Map<string, number>();

  for (const row of rows) {
    if (!row.player) {
      continue;
    }

    const all = league.get(bandOf(row.airYards));
    expected.set(
      row.player,
      (expected.get(row.player) ?? 0) + (all && all.n > 0 ? all.made / all.n : 0),
    );
  }

  const leaning = new Map<string, number>();

  for (const [player, own] of his) {
    const should = expected.get(player) ?? 0;

    if (own.n < ENOUGH || should <= 0) {
      continue;
    }

    const trust = own.n / (own.n + SETTLES_AT);
    const raw = own.made / should;
    leaning.set(player, Math.max(1 / MOST, Math.min(MOST,
      trust * raw + (1 - trust))));
  }

  let everyAir = 0;
  let everyAfter = 0;

  for (const row of rows) {
    everyAir += row.airYards;
    everyAfter += row.afterCatch;
  }

  return {
    learnedFrom: leaning.size,
    shareAfter: everyAir + everyAfter > 0
      ? everyAfter / (everyAir + everyAfter)
      : 0.46,
    leanOf: (player) => leaning.get(player) ?? 1,
  };
}

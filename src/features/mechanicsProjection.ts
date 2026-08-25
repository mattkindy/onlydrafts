/**
 * A man's next season built from the parts of his play rather than from
 * what those parts added up to.
 *
 * Each part keeps a different amount of itself, so each is pulled back
 * toward the league by its own amount. How far the ball travels to him
 * keeps 0.878 and barely moves; his drops keep 0.176 and go nearly all
 * the way back. Projecting his yards a target as one number applies the
 * same pull to all of it and throws the difference away.
 *
 * The numbers are measured in scripts/mechanicsCarryEval.ts.
 */

/** how much of each part a man takes into next season */
export const KEEPS = {
  targetsPerGame: 0.701,
  caughtShare: 0.600,
  /**
   * Per catch, not per target. A deep ball is caught less often, so how
   * far the ball goes when he is thrown at and how far it goes when he
   * catches it are different numbers, and only the second one adds up
   * to yards.
   */
  beforeCatch: 0.878,
  afterCatch: 0.688,
  dropShare: 0.176,
  carriesPerGame: 0.613,
  beforeContact: 0.581,
  afterContact: 0.439,
} as const;

export type Part = keyof typeof KEEPS;

/**
 * A season is only worth so much evidence. A man with forty targets is
 * telling us less about himself than one with a hundred and sixty, and
 * the carryover above is what an ordinary season's worth earns.
 */
const SETTLES_AT = { targets: 70, carries: 110, games: 8 } as const;

export interface Receiving {
  games: number;
  targets: number;
  receptions: number;
  /** how far the ball travelled and how far he took it, over his catches */
  beforeCatch: number;
  afterCatch: number;
  drops: number;
}

export interface Running {
  games: number;
  carries: number;
  beforeContact: number;
  afterContact: number;
}

/**
 * What everyone at his position did, which is where a thin season goes.
 *
 * This has to be his own position group. Handed a back's carries, a
 * receiver who has never run it comes out with four a game, because the
 * pull back toward the league can only take him 60% of the way there.
 */
export interface League {
  receiving: Omit<Receiving, "games">;
  running: Omit<Running, "games">;
}

/**
 * Pull one part back toward the league by what it keeps, and further
 * when there is not much of a season behind it.
 */
export function settle(
  part: Part, his: number, everyone: number, evidence: number, settlesAt: number,
): number {
  if (!Number.isFinite(his)) {
    return everyone;
  }

  const trust = evidence / (evidence + settlesAt);

  return everyone + KEEPS[part] * trust * (his - everyone);
}

export interface Projected {
  targetsPerGame: number;
  caughtShare: number;
  beforeCatch: number;
  afterCatch: number;
  carriesPerGame: number;
  beforeContact: number;
  afterContact: number;
  /** and what those come to, per game */
  recYds: number;
  receptions: number;
  rushYds: number;
}

const rate = (top: number, bottom: number, fallback: number) =>
  bottom > 0 ? top / bottom : fallback;

export function projectFromMechanics(
  receiving: Receiving,
  running: Running,
  league: League,
): Projected {
  const theirs = league.receiving;
  const ran = league.running;
  const targets = receiving.targets;
  const carries = running.carries;

  // How often he gets it is measured over his games, not over his
  // touches. A man who played a season and never carried it has told
  // us plenty, and counting his carries as his evidence said the
  // opposite and handed him the league average.
  const targetsPerGame = settle(
    "targetsPerGame",
    rate(targets, receiving.games, 0),
    rate(theirs.targets, 17, 0),
    receiving.games, SETTLES_AT.games,
  );
  const caughtShare = settle(
    "caughtShare",
    rate(receiving.receptions, targets, 0),
    rate(theirs.receptions, theirs.targets, 0.62),
    targets, SETTLES_AT.targets,
  );
  const beforeCatch = settle(
    "beforeCatch",
    rate(receiving.beforeCatch, receiving.receptions, 0),
    rate(theirs.beforeCatch, theirs.receptions, 7.5),
    receiving.receptions, SETTLES_AT.targets,
  );
  const afterCatch = settle(
    "afterCatch",
    rate(receiving.afterCatch, receiving.receptions, 0),
    rate(theirs.afterCatch, theirs.receptions, 4.5),
    receiving.receptions, SETTLES_AT.targets,
  );
  const carriesPerGame = settle(
    "carriesPerGame",
    rate(carries, running.games, 0),
    rate(ran.carries, 17, 0),
    running.games, SETTLES_AT.games,
  );
  const beforeContact = settle(
    "beforeContact",
    rate(running.beforeContact, carries, 0),
    rate(ran.beforeContact, ran.carries, 2.8),
    carries, SETTLES_AT.carries,
  );
  const afterContact = settle(
    "afterContact",
    rate(running.afterContact, carries, 0),
    rate(ran.afterContact, ran.carries, 1.6),
    carries, SETTLES_AT.carries,
  );

  const receptions = targetsPerGame * caughtShare;

  return {
    targetsPerGame, caughtShare, beforeCatch, afterCatch,
    carriesPerGame, beforeContact, afterContact,
    // a catch is worth however far the ball went plus however far he
    // took it, and only the caught ones count for either
    receptions,
    recYds: receptions * (beforeCatch + afterCatch),
    rushYds: carriesPerGame * (beforeContact + afterContact),
  };
}

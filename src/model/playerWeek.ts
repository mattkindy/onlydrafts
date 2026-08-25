/**
 * A player's week, built the way the game produces it rather than as a
 * mean with noise added.
 *
 * The order matters. A team gets a number of plays and splits them
 * into passes and runs. Its receivers compete for that pass total and
 * its backs for the hand-offs, so when one sees a lot the others see
 * less; adding independent noise to separate means cannot do that and
 * lets a whole receiving room boom in the same week. Touchdowns are
 * drawn as counts, because six points arriving at once is most of what
 * makes a week a good one. Fantasy points are whatever the league's
 * rules make of the drawn line, so a distribution comes out.
 */

import type { StatLine } from "../scoring/fantasyPoints.js";

export interface TeamWeek {
  /** pass attempts the offence is expected to throw */
  passAttempts: number;
  /** hand-offs it is expected to give */
  rushAttempts: number;
  /** points it is expected to score */
  impliedTotal: number;
}

export interface PlayerRole {
  playerId: string;
  position: string;
  /** share of the team's pass attempts thrown his way */
  targetShare: number;
  /** share of the team's hand-offs */
  carryShare: number;
  /** how often a target is caught */
  catchRate: number;
  yardsPerCatch: number;
  yardsPerCarry: number;
  /** share of the team's touchdowns he takes */
  touchdownShare: number;
  /** how often he is active and healthy enough to play */
  availability: number;
}

/** every draw the model needs, so a caller can seed and repeat a run */
export interface Draws {
  uniform: () => number;
  normal: () => number;
}

export interface PlayerLine extends StatLine {
  playerId: string;
  played: boolean;
  /**
   * How often he got it. No league pays for these, and they are the
   * steadiest thing about a player, so a walk that counts them can say
   * whether a quiet week was fewer touches or less done with them.
   */
  carries?: number;
  targets?: number;
  passAtt?: number;
  passCmp?: number;
}

const BLANK: StatLine = {
  passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0, fumblesLost: 0, twoPointConversions: 0,
};

function poisson(mean: number, uniform: () => number): number {
  if (mean <= 0) {
    return 0;
  }

  const limit = Math.exp(-mean);
  let count = 0;
  let product = uniform();

  while (product > limit) {
    count++;
    product *= uniform();
  }

  return count;
}

/** Marsaglia and Tsang, with the small-shape boost */
function gamma(shape: number, draws: Draws): number {
  if (shape < 1) {
    return gamma(shape + 1, draws) * Math.pow(draws.uniform(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    const x = draws.normal();
    const v = Math.pow(1 + c * x, 3);

    if (v <= 0) {
      continue;
    }

    const u = draws.uniform();

    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/**
 * Splits a total among competitors by drawing each one's appetite and
 * normalising, which is what makes their shares move against each
 * other. `firmness` says how settled the roles are: a fixed depth
 * chart stays near its shares, a committee wanders.
 */
export function shareDraw(
  shares: number[],
  firmness: number,
  draws: Draws,
): number[] {
  const drawn = shares.map((share) =>
    share <= 0 ? 0 : gamma(Math.max(0.05, share * firmness), draws),
  );
  const total = drawn.reduce((sum, value) => sum + value, 0);

  return total > 0 ? drawn.map((value) => value / total) : shares;
}

/**
 * How firmly each depth chart holds, fitted by matching how far a
 * man's weekly share wanders from his season share. Over 160
 * team-seasons a backfield wanders at .859 and a receiving room at
 * .708, which comes out as 6 and 16. A committee rotates; a target
 * order does not. Whether the play-caller changed makes no difference
 * to either.
 */
export const FIRMNESS = { carries: 6, targets: 16 };

/**
 * One simulated week for a whole offence. Taking the team as the unit
 * is the point: the same pass total is divided among its receivers, so
 * their weeks move against each other the way the real ones do.
 */
export function simulateTeamWeek(
  team: TeamWeek,
  roster: PlayerRole[],
  draws: Draws,
  firmness = FIRMNESS,
): PlayerLine[] {
  const active = roster.map((player) => draws.uniform() < player.availability);

  // Callers rarely pass a whole offence, so the rest of it competes as
  // one extra mouth. Without it three receivers would split every pass
  // the team throws, and whoever is missing would hand his targets
  // only to the players we happen to be modelling.
  const withRest = (get: (p: PlayerRole) => number, holds: number) => {
    const shares = roster.map((p, i) => (active[i] ? get(p) : 0));
    const rest = Math.max(0, 1 - roster.reduce((sum, p) => sum + get(p), 0));
    return shareDraw([...shares, rest], holds, draws).slice(0, roster.length);
  };

  const targetShares = withRest((p) => p.targetShare, firmness.targets);
  const carryShares = withRest((p) => p.carryShare, firmness.carries);
  // scoring follows whichever way he is used
  const scoreShares = withRest((p) => p.touchdownShare, firmness.targets);

  // the offence has a good or bad day before anyone divides it up
  const form = Math.max(0.4, 1 + draws.normal() * 0.22);
  const attempts = team.passAttempts * form;
  const rushes = team.rushAttempts * Math.max(0.4, 1 + draws.normal() * 0.18);
  // field goals and extra points take a bite out of the total
  const teamScores = poisson((team.impliedTotal / 9) * form, draws.uniform);

  return roster.map((player, i) => {
    if (!active[i]) {
      return { ...BLANK, playerId: player.playerId, played: false };
    }

    const targets = Math.round(attempts * targetShares[i]!);
    const carries = Math.round(rushes * carryShares[i]!);
    let receptions = 0;

    for (let t = 0; t < targets; t++) {
      if (draws.uniform() < player.catchRate) {
        receptions++;
      }
    }

    // yards per touch swing far more than the touch counts do
    const scores = poisson(teamScores * scoreShares[i]!, draws.uniform);
    const throughAir = carries > targets ? 0 : scores;

    return {
      ...BLANK,
      playerId: player.playerId,
      played: true,
      receptions,
      recYds: receptions * player.yardsPerCatch * Math.max(0, 1 + draws.normal() * 0.55),
      rushYds: carries * player.yardsPerCarry * Math.max(0, 1 + draws.normal() * 0.4),
      recTd: throughAir,
      rushTd: scores - throughAir,
    };
  });
}

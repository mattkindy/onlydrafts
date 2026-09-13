/**
 * How one player's week moves with the other players in his game.
 *
 * Everybody reads his week off his own five figures, so nobody's
 * distribution changes. What changes is where in it he lands: the
 * number picking the quantile is shared factors plus his own noise,
 * scaled to unit variance and put through the normal CDF. That is a
 * Gaussian copula, and the game correlation note measures the loadings.
 *
 * A player is loadings on named factors plus what is left for his own
 * noise. The season draws add that up; the live draws also solve it
 * backwards, asking what the players who have played say about the factors.
 */

import { normalStream } from "./spread.ts";

export const SCRIPT_LOAD = 0.65;
export const SPLIT_LOAD = 0.65;
export const QB_LOAD = 0.6;
export const DEF_LOAD = -0.5;
export const GAME_LOAD = 0.45;

export const PASS_CATCHERS = ["WR", "TE"];

export interface Player {
  key: string;
  position: string;
  team?: string | null;
}

/** one named factor and how much of a player's week rides on it */
export interface Term {
  factor: string;
  load: number;
}

/** a player's week as shared factors plus noise of his own */
export interface Mix {
  terms: Term[];
  /** what the loadings leave for his own noise */
  own: number;
  /** the stream that noise is drawn from */
  ownSeed: string;
}

const rest = (load: number) => Math.sqrt(Math.max(0, 1 - load * load));

/** what a pass catcher's two loadings leave for his own noise */
const CATCHER_REST = Math.sqrt(Math.max(
  0, 1 - SCRIPT_LOAD * SCRIPT_LOAD - SPLIT_LOAD * SPLIT_LOAD));

/**
 * A team's game script, as loadings: its own factor, and, where the
 * fixture is known, a share of the factor the two sides of that game
 * have in common. The game factor is named off both teams sorted, so
 * each side reaches the same one without asking the other.
 */
function scriptTerms(
  team: string, against: string | null, week: number, load: number,
): Term[] {
  if (!against) {
    return [{ factor: `script|${team}`, load }];
  }

  const pair = [team, against].sort().join("|");

  return [
    { factor: `script|${team}`, load: load * rest(GAME_LOAD) },
    { factor: `game|${pair}|${week}`, load: load * GAME_LOAD },
  ];
}

const alone = (player: Player): Mix =>
  ({ terms: [], own: 1, ownSeed: `own|${player.key}` });

/**
 * What a player's week is loaded on. `top` says whether he is his team's
 * first pass catcher, which decides the sign he takes the split factor
 * with; null means nobody has said, and then he takes the script and
 * nothing else, because there is no sign to take the split with.
 *
 * The split factor only has two signs, so the first pass catcher comes
 * out uncorrelated with each of the others, and any two of the others
 * pick up about 0.42 between them where the measurement says zero.
 */
export function mixFor(
  player: Player, against: string | null, week: number, top: boolean | null,
): Mix {
  const ownSeed = `own|${player.key}`;

  if (!player.team) {
    return alone(player);
  }

  if (player.position === "QB") {
    return {
      terms: scriptTerms(player.team, against, week, QB_LOAD),
      own: rest(QB_LOAD),
      ownSeed,
    };
  }

  if (player.position === "DEF") {
    if (!against) {
      return alone(player);
    }

    return {
      terms: scriptTerms(against, player.team, week, DEF_LOAD),
      own: rest(DEF_LOAD),
      ownSeed,
    };
  }

  if (!PASS_CATCHERS.includes(player.position)) {
    return alone(player);
  }

  const script = scriptTerms(player.team, against, week, SCRIPT_LOAD);

  if (top === null) {
    return { terms: script, own: rest(SCRIPT_LOAD), ownSeed };
  }

  return {
    terms: [
      ...script,
      { factor: `split|${player.team}`, load: top ? SPLIT_LOAD : -SPLIT_LOAD },
    ],
    own: CATCHER_REST,
    ownSeed,
  };
}

const streams = new Map<string, number[]>();

/** a named factor's draws, kept because every player in a game wants them */
export function factorFor(seed: string, draws: number): number[] {
  const at = `${seed}|${draws}`;
  let its = streams.get(at);

  if (!its) {
    its = normalStream(seed, draws);
    streams.set(at, its);
  }

  return its;
}

/** where a factor's numbers come from, so a caller can substitute them */
export type From = (seed: string, draws: number) => number[];

/** a player's copula normal in one draw, factors and noise added up */
export function normalAt(
  mix: Mix, i: number, draws: number, from: From = factorFor,
): number {
  return sharedAt(mix, i, draws, from) +
    mix.own * from(mix.ownSeed, draws)[i]!;
}

/** the shared part of a player's copula normal, his own noise left out */
export function sharedAt(
  mix: Mix, i: number, draws: number, from: From = factorFor,
): number {
  let z = 0;

  for (const term of mix.terms) {
    z += term.load * from(term.factor, draws)[i]!;
  }

  return z;
}

/** how much of a player's game is behind him, and where his pace puts him */
export interface Pace {
  played: number;
  /** the normal his pace so far corresponds to */
  z: number;
}

/**
 * The share of a week's variance that is the rate a player is playing at
 * rather than which plays happened to break his way.
 *
 * A fraction q of a game measures the rate part and adds q of the play
 * noise, so the pace is worth q r / (q r + 1 - r) and no more. The probe
 * that fits this on five seasons of touches cannot tell the rate share
 * from zero at any cut up to half a game, so this is the most the
 * measurement allows rather than a number read off it.
 */
export const RATE_SHARE = 0.1;

/** how much a pace over a fraction of a game is believed */
export const paceWeight = (played: number) =>
  (played * RATE_SHARE) / (played * RATE_SHARE + 1 - RATE_SHARE);

/**
 * How little of a game can be left before the remaining week is read off
 * a normal so far out that the ladder has nothing to say there. Half
 * time hands a game to the drive engine, so nothing near this arrives.
 */
const LEAST_LEFT = 0.25;

/**
 * A player's copula normal written as a straight line in his own noise, so
 * a caller can either draw that noise or ask where the line crosses a
 * total it has to beat.
 *
 * Once his game is under way the pace pulls the rest of his week toward
 * it by paceWeight. The width grows with what is left, because the
 * caller scales a whole week down by the fraction still to play and the
 * plays in a quarter vary by more than a quarter of a game's worth.
 */
export function normalLine(
  mix: Mix, shared: number, pace: Pace,
): { middle: number; width: number } {
  if (pace.played <= 0) {
    return { middle: shared, width: mix.own };
  }

  const weight = paceWeight(pace.played);
  const left = Math.max(LEAST_LEFT, 1 - pace.played);
  const spread = RATE_SHARE * (1 - weight) + (1 - RATE_SHARE) / left;

  return {
    middle: (1 - weight) * shared + weight * pace.z,
    width: mix.own * Math.sqrt(Math.max(0, spread)),
  };
}

/**
 * The same player, tied only to the factors named. What he was loaded on
 * elsewhere goes into his own noise, so his week has the distribution it
 * had and moves with nobody outside that list.
 */
export function tiedTo(mix: Mix, factors: Set<string>): Mix {
  const terms = mix.terms.filter((term) => factors.has(term.factor));
  const loose = mix.terms.filter((term) => !factors.has(term.factor));
  const own = loose.reduce(
    (sum, term) => sum + term.load * term.load, mix.own * mix.own);

  return { ...mix, terms, own: Math.sqrt(own) };
}

/** a player whose week is partly played, and where his pace puts him */
export interface Seen {
  mix: Mix;
  /** the normal his pace so far corresponds to */
  z: number;
  /** how much the pace is not to be trusted, as added variance */
  noise: number;
}

/** the factors a run of players are loaded on, once each */
export function factorsOf(mixes: Mix[]): string[] {
  const named = new Set<string>();

  for (const mix of mixes) {
    for (const term of mix.terms) {
      named.add(term.factor);
    }
  }

  return [...named];
}

/** kept off the diagonal so a near singular system still decomposes */
const JITTER = 1e-9;

function cholesky(m: number[][]): number[][] {
  const n = m.length;
  const l = m.map(() => new Array(n).fill(0) as number[]);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = m[i]![j]!;

      for (let k = 0; k < j; k++) {
        sum -= l[i]![k]! * l[j]![k]!;
      }

      if (i === j) {
        l[i]![j] = Math.sqrt(Math.max(JITTER, sum));
      } else {
        l[i]![j] = sum / l[j]![j]!;
      }
    }
  }

  return l;
}

/** x where L Lᵀ x = b */
function solveWith(l: number[][], b: number[]): number[] {
  const n = l.length;
  const y = new Array(n).fill(0) as number[];

  for (let i = 0; i < n; i++) {
    let sum = b[i]!;

    for (let k = 0; k < i; k++) {
      sum -= l[i]![k]! * y[k]!;
    }

    y[i] = sum / l[i]![i]!;
  }

  const x = new Array(n).fill(0) as number[];

  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;

    for (let k = i + 1; k < n; k++) {
      sum -= l[k]![i]! * x[k]!;
    }

    x[i] = sum / l[i]![i]!;
  }

  return x;
}

export interface Posterior {
  /** what each factor is worth on average, given what has been seen */
  mean: number[];
  /** the spread left around that, as a lower triangle to draw with */
  spread: number[][];
}

/**
 * What the players who have already played say about the factors their game
 * shares out.
 *
 * The factors are standard normals and every player is a fixed combination
 * of them plus noise of his own, so this is a linear Gaussian system and
 * the answer is written down rather than searched for. With A the
 * loadings of the players seen, one row each, and D the variance left to
 * each of them, the seen numbers have covariance A Aᵀ + D, the factors
 * come out at Aᵀ (A Aᵀ + D)⁻¹ z on average, and what is left around
 * them is I − Aᵀ (A Aᵀ + D)⁻¹ A.
 */
export function posteriorFor(seen: Seen[], factors: string[]): Posterior {
  const k = factors.length;
  const at = new Map(factors.map((name, i) => [name, i]));
  const a = seen.map((player) => {
    const row = new Array(k).fill(0) as number[];

    for (const term of player.mix.terms) {
      const j = at.get(term.factor);

      if (j != null) {
        row[j] = row[j]! + term.load;
      }
    }

    return row;
  });
  const n = seen.length;
  const s = a.map((row, i) => a.map((other, j) => {
    let sum = i === j ? seen[i]!.mix.own ** 2 + seen[i]!.noise : 0;

    for (let f = 0; f < k; f++) {
      sum += row[f]! * other[f]!;
    }

    return sum;
  }));
  const l = cholesky(s);
  const solvedZ = solveWith(l, seen.map((player) => player.z));
  const mean = Array.from({ length: k }, (_, f) =>
    a.reduce((sum, row, i) => sum + row[f]! * solvedZ[i]!, 0));
  // one solve per factor, on the column of A that factor appears in
  const solvedA = Array.from({ length: k }, (_, f) =>
    solveWith(l, Array.from({ length: n }, (_, i) => a[i]![f]!)));
  const cov = Array.from({ length: k }, (_, f) =>
    Array.from({ length: k }, (_, g) => {
      const shared = a.reduce(
        (sum, row, i) => sum + row[f]! * solvedA[g]![i]!, 0);

      return (f === g ? 1 : 0) - shared;
    }));

  return { mean, spread: cholesky(cov) };
}

/**
 * A posterior's factors, drawn: each one's mean plus the spread left
 * around it, off normals named for the game so the numbers come out the
 * same every time the page is opened.
 */
export function posteriorDraws(
  posterior: Posterior, factors: string[], named: string, draws: number,
): Map<string, number[]> {
  const noise = factors.map((_, f) =>
    factorFor(`${named}|posterior|${f}`, draws));
  const out = new Map<string, number[]>();

  factors.forEach((name, f) => {
    out.set(name, Array.from({ length: draws }, (_, i) => {
      let value = posterior.mean[f]!;

      for (let g = 0; g <= f; g++) {
        value += posterior.spread[f]![g]! * noise[g]![i]!;
      }

      return value;
    }));
  });

  return out;
}

/**
 * How one man's week moves with the other men in his game.
 *
 * Everybody reads his week off his own five figures, so nobody's
 * distribution changes. What changes is where in it he lands: the
 * number picking the quantile is shared factors plus his own noise,
 * scaled to unit variance and put through the normal CDF. That is a
 * Gaussian copula, and the game correlation note measures the loadings.
 *
 * A man is loadings on named factors plus what is left for his own
 * noise. The season draws add that up; the live draws also solve it
 * backwards, asking what the men who have played say about the factors.
 */

import { normalStream } from "./spread.ts";

export const SCRIPT_LOAD = 0.65;
export const SPLIT_LOAD = 0.65;
export const QB_LOAD = 0.6;
export const DEF_LOAD = -0.5;
export const GAME_LOAD = 0.45;

export const PASS_CATCHERS = ["WR", "TE"];

export interface Man {
  key: string;
  position: string;
  team?: string | null;
}

/** one named factor and how much of a man's week rides on it */
export interface Term {
  factor: string;
  load: number;
}

/** a man's week as shared factors plus noise of his own */
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

const alone = (man: Man): Mix =>
  ({ terms: [], own: 1, ownSeed: `own|${man.key}` });

/**
 * What a man's week is loaded on. `top` says whether he is his team's
 * first pass catcher, which decides the sign he takes the split factor
 * with; null means nobody has said, and then he takes the script and
 * nothing else, because there is no sign to take the split with.
 *
 * The split factor only has two signs, so the first pass catcher comes
 * out uncorrelated with each of the others, and any two of the others
 * pick up about 0.42 between them where the measurement says nought.
 */
export function mixFor(
  man: Man, against: string | null, week: number, top: boolean | null,
): Mix {
  const ownSeed = `own|${man.key}`;

  if (!man.team) {
    return alone(man);
  }

  if (man.position === "QB") {
    return {
      terms: scriptTerms(man.team, against, week, QB_LOAD),
      own: rest(QB_LOAD),
      ownSeed,
    };
  }

  if (man.position === "DEF") {
    if (!against) {
      return alone(man);
    }

    return {
      terms: scriptTerms(against, man.team, week, DEF_LOAD),
      own: rest(DEF_LOAD),
      ownSeed,
    };
  }

  if (!PASS_CATCHERS.includes(man.position)) {
    return alone(man);
  }

  const script = scriptTerms(man.team, against, week, SCRIPT_LOAD);

  if (top === null) {
    return { terms: script, own: rest(SCRIPT_LOAD), ownSeed };
  }

  return {
    terms: [
      ...script,
      { factor: `split|${man.team}`, load: top ? SPLIT_LOAD : -SPLIT_LOAD },
    ],
    own: CATCHER_REST,
    ownSeed,
  };
}

const streams = new Map<string, number[]>();

/** a named factor's draws, kept because every man in a game wants them */
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

/** a man's copula normal in one draw, factors and noise added up */
export function normalAt(
  mix: Mix, i: number, draws: number, from: From = factorFor,
): number {
  let z = mix.own * from(mix.ownSeed, draws)[i]!;

  for (const term of mix.terms) {
    z += term.load * from(term.factor, draws)[i]!;
  }

  return z;
}

/** a man whose week is partly played, and where his pace puts him */
export interface Seen {
  mix: Mix;
  /** the normal his pace so far corresponds to */
  z: number;
  /** how much the pace is not to be trusted, as added variance */
  noise: number;
}

/** the factors a run of men are loaded on, once each */
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
 * What the men who have already played say about the factors their game
 * shares out.
 *
 * The factors are standard normals and every man is a fixed combination
 * of them plus noise of his own, so this is a linear Gaussian system and
 * the answer is written down rather than searched for. With A the
 * loadings of the men seen, one row each, and D the variance left to
 * each of them, the seen numbers have covariance A Aᵀ + D, the factors
 * come out at Aᵀ (A Aᵀ + D)⁻¹ z on average, and what is left around
 * them is I − Aᵀ (A Aᵀ + D)⁻¹ A.
 */
export function posteriorFor(seen: Seen[], factors: string[]): Posterior {
  const k = factors.length;
  const at = new Map(factors.map((name, i) => [name, i]));
  const a = seen.map((man) => {
    const row = new Array(k).fill(0) as number[];

    for (const term of man.mix.terms) {
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
  const solvedZ = solveWith(l, seen.map((man) => man.z));
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

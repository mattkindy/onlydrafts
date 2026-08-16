/**
 * The same idea as fitPlusMinus, carried through time instead of refit
 * from scratch each season.
 *
 * Each player has a running estimate and a running uncertainty. Every
 * week both drift a little, and a week a man does not play drifts his
 * uncertainty further, because nothing was learned about him while he
 * was out. Then the week's snaps pull the estimates around, and a
 * player we are unsure about moves further on the same evidence.
 *
 * Nothing here says an injury makes a player worse. If he comes back
 * diminished, the wide prior he returns with lets a couple of weeks of
 * snaps say so, and if he comes back fine it says that instead.
 */

import type { Snap } from "./plusMinus.js";

export interface Belief {
  /** what we think he adds, above an average player */
  mean: number;
  /** how unsure we are, as a variance */
  variance: number;
}

export interface DynamicState {
  players: Map<string, Belief>;
  /** the outcome when nobody's effect is counted */
  baseline: number;
}

export interface DynamicSettings {
  /** how far ability wanders in a week he plays */
  drift: number;
  /** how far it wanders in a week he does not, which is further */
  driftWhileOut: number;
  /** how noisy one snap is */
  snapNoise: number;
  /** what we assume about a man before we have seen him */
  priorVariance: number;
  /** cap on how unsure we let ourselves get */
  maxVariance: number;
}

export const DEFAULTS: DynamicSettings = {
  drift: 0.00002,
  driftWhileOut: 0.0002,
  snapNoise: 0.2,
  priorVariance: 0.002,
  maxVariance: 0.01,
};

export function emptyState(baseline: number): DynamicState {
  return { players: new Map(), baseline };
}

/**
 * A week passes. Estimates stay put and uncertainties grow, faster for
 * whoever was not on the field.
 */
export function advance(
  state: DynamicState,
  played: Set<string>,
  settings: DynamicSettings = DEFAULTS,
): DynamicState {
  const players = new Map<string, Belief>();

  for (const [id, belief] of state.players) {
    const growth = played.has(id) ? settings.drift : settings.driftWhileOut;
    players.set(id, {
      mean: belief.mean,
      variance: Math.min(settings.maxVariance, belief.variance + growth),
    });
  }

  return { players, baseline: state.baseline };
}

/**
 * Fold a week of snaps in. This is ridge again, except each player is
 * pulled toward what we already believed rather than toward zero, and
 * how hard depends on how sure we were. A man we know well barely
 * moves; a man back from six weeks out moves a long way.
 */
export function observe(
  state: DynamicState,
  snaps: Snap[],
  settings: DynamicSettings = DEFAULTS,
  rounds = 60,
): DynamicState {
  if (snaps.length === 0) {
    return state;
  }

  const index = new Map<string, number>();
  const prior: number[] = [];
  const precision: number[] = [];
  const seen: number[] = [];

  const register = (id: string) => {
    if (index.has(id)) {
      return index.get(id)!;
    }

    const at = index.size;
    index.set(id, at);
    const belief = state.players.get(id) ?? { mean: 0, variance: settings.priorVariance };
    prior.push(belief.mean);
    // an uncertain player is pulled toward his prior only weakly
    precision.push(settings.snapNoise / Math.max(belief.variance, 1e-9));
    seen.push(0);
    return at;
  };

  const rows = snaps.map((snap) => {
    const plus = snap.forIt.map(register);
    const minus = snap.against.map(register);

    for (const at of [...plus, ...minus]) {
      seen[at] = seen[at]! + 1;
    }

    return { plus, minus, y: snap.outcome - state.baseline };
  });

  const size = index.size;
  const offset = new Float64Array(size);

  // solve for the move away from the prior, so the prior is the origin
  const forward = (v: Float64Array) => {
    const out = new Float64Array(rows.length);

    for (let i = 0; i < rows.length; i++) {
      let total = 0;

      for (const j of rows[i]!.plus) {
        total += v[j]!;
      }

      for (const j of rows[i]!.minus) {
        total -= v[j]!;
      }

      out[i] = total;
    }

    return out;
  };

  const backward = (r: Float64Array) => {
    const out = new Float64Array(size);

    for (let i = 0; i < rows.length; i++) {
      const value = r[i]!;

      for (const j of rows[i]!.plus) {
        out[j] = out[j]! + value;
      }

      for (const j of rows[i]!.minus) {
        out[j] = out[j]! - value;
      }
    }

    return out;
  };

  const applyNormal = (v: Float64Array) => {
    const out = backward(forward(v));

    for (let j = 0; j < size; j++) {
      out[j] = out[j]! + precision[j]! * v[j]!;
    }

    return out;
  };

  // what the week's snaps say, net of what the prior already explains
  const priorFit = forward(Float64Array.from(prior));
  const target = backward(
    Float64Array.from(rows.map((row, i) => row.y - priorFit[i]!)),
  );

  let residual = Float64Array.from(target);
  let direction = Float64Array.from(residual);
  let norm = dot(residual, residual);

  for (let step = 0; step < rounds && norm > 1e-12; step++) {
    const applied = applyNormal(direction);
    const alpha = norm / dot(direction, applied);

    for (let j = 0; j < size; j++) {
      offset[j] = offset[j]! + alpha * direction[j]!;
      residual[j] = residual[j]! - alpha * applied[j]!;
    }

    const next = dot(residual, residual);
    const ratio = next / norm;

    for (let j = 0; j < size; j++) {
      direction[j] = residual[j]! + ratio * direction[j]!;
    }

    norm = next;
  }

  const players = new Map(state.players);

  for (const [id, at] of index) {
    const before = state.players.get(id)?.variance ?? settings.priorVariance;
    // each snap he took buys a little certainty
    const after = 1 / (1 / before + seen[at]! / settings.snapNoise);
    players.set(id, { mean: prior[at]! + offset[at]!, variance: after });
  }

  return { players, baseline: state.baseline };
}

function dot(a: Float64Array, b: Float64Array): number {
  let total = 0;

  for (let i = 0; i < a.length; i++) {
    total += a[i]! * b[i]!;
  }

  return total;
}

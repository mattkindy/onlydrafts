/**
 * Learns what each man contributes from nothing but who was on the
 * field and what happened.
 *
 * Every snap names eleven players a side and one outcome. Nobody says
 * which lineman lost his block or whether the corner travelled, and
 * none of that has to be written down: a player who is on the field
 * for a lot of pressure, against a run of different opponents, ends up
 * with the credit once everyone he shared a field with is accounted
 * for. The schedule does the untangling.
 *
 * A team is then whatever its current men add up to, so a line that
 * loses three starters is a different line, without anyone saying so.
 */

/** one snap: who helped, who opposed, and what came of it */
export interface Snap {
  forIt: string[];
  against: string[];
  outcome: number;
}

export interface PlusMinus {
  /** each man's effect on the outcome, relative to a replacement */
  effects: Map<string, number>;
  /** the outcome with nobody's effect counted */
  baseline: number;
  /** snaps each man was seen for, so callers can ignore thin evidence */
  snaps: Map<string, number>;
}

/**
 * Ridge by conjugate gradient. The matrix is never built: it has 22
 * entries a row out of thousands of columns, so every product runs
 * over the snaps instead.
 */
export function fitPlusMinus(snaps: Snap[], penalty = 400): PlusMinus {
  const index = new Map<string, number>();
  const seen = new Map<string, number>();

  for (const snap of snaps) {
    for (const id of [...snap.forIt, ...snap.against]) {
      if (!index.has(id)) {
        index.set(id, index.size);
      }

      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
  }

  const size = index.size;
  const baseline = snaps.reduce((sum, s) => sum + s.outcome, 0) / snaps.length;
  const signs = snaps.map((snap) => ({
    plus: snap.forIt.map((id) => index.get(id)!),
    minus: snap.against.map((id) => index.get(id)!),
    y: snap.outcome - baseline,
  }));

  /** X times a vector: each snap sums its side's effects */
  const forward = (beta: Float64Array): Float64Array => {
    const out = new Float64Array(signs.length);

    for (let i = 0; i < signs.length; i++) {
      let total = 0;

      for (const j of signs[i]!.plus) {
        total += beta[j]!;
      }

      for (const j of signs[i]!.minus) {
        total -= beta[j]!;
      }

      out[i] = total;
    }

    return out;
  };

  /** X transposed times a vector: hand each snap's value back to its men */
  const backward = (residual: Float64Array): Float64Array => {
    const out = new Float64Array(size);

    for (let i = 0; i < signs.length; i++) {
      const value = residual[i]!;

      for (const j of signs[i]!.plus) {
        out[j] = out[j]! + value;
      }

      for (const j of signs[i]!.minus) {
        out[j] = out[j]! - value;
      }
    }

    return out;
  };

  const applyNormal = (beta: Float64Array): Float64Array => {
    const out = backward(forward(beta));

    for (let j = 0; j < size; j++) {
      out[j] = out[j]! + penalty * beta[j]!;
    }

    return out;
  };

  const target = backward(Float64Array.from(signs.map((s) => s.y)));
  const beta = new Float64Array(size);
  let residual = Float64Array.from(target);
  let direction = Float64Array.from(residual);
  let residualNorm = dot(residual, residual);

  for (let step = 0; step < 200 && residualNorm > 1e-10; step++) {
    const applied = applyNormal(direction);
    const alpha = residualNorm / dot(direction, applied);

    for (let j = 0; j < size; j++) {
      beta[j] = beta[j]! + alpha * direction[j]!;
      residual[j] = residual[j]! - alpha * applied[j]!;
    }

    const next = dot(residual, residual);
    const ratio = next / residualNorm;

    for (let j = 0; j < size; j++) {
      direction[j] = residual[j]! + ratio * direction[j]!;
    }

    residualNorm = next;
  }

  const effects = new Map<string, number>();

  for (const [id, j] of index) {
    effects.set(id, beta[j]!);
  }

  return { effects, baseline, snaps: seen };
}

function dot(a: Float64Array, b: Float64Array): number {
  let total = 0;

  for (let i = 0; i < a.length; i++) {
    total += a[i]! * b[i]!;
  }

  return total;
}

/** what to expect when these men line up against those men */
export function expectedOutcome(
  fit: PlusMinus,
  forIt: string[],
  against: string[],
): number {
  let total = fit.baseline;

  for (const id of forIt) {
    total += fit.effects.get(id) ?? 0;
  }

  for (const id of against) {
    total -= fit.effects.get(id) ?? 0;
  }

  return total;
}

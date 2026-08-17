/**
 * Learns which combinations matter instead of being told them.
 *
 * Every entity on a play gets a vector: this offence, this defence,
 * this coordinator, this passer, this down, this personnel grouping.
 * What the play produces depends on the vectors of whoever was
 * involved and on how they line up with each other. So "third down
 * depth belongs to the quarterback" is not a rule anyone writes, it is
 * what his vector ends up carrying because that is what predicts the
 * yards, and an interaction nobody thought to look for is found on the
 * same footing as one somebody did.
 */

export interface Example {
  /** which entities were on this play, as `kind:value` */
  features: string[];
  target: number;
}

export interface Factorization {
  bias: number;
  /** the target is fitted standardised, and put back on scale here */
  scale: number;
  centre: number;
  /** each entity's own pull on the outcome */
  weight: Map<string, number>;
  /** and its vector, for how it combines with the others */
  vector: Map<string, Float64Array>;
  rank: number;
}

export interface FitSettings {
  rank: number;
  passes: number;
  rate: number;
  /** pulls weights and vectors back toward nothing */
  penalty: number;
  seed: number;
}

export const FIT_DEFAULTS: FitSettings = {
  rank: 8,
  passes: 12,
  rate: 0.02,
  penalty: 2e-5,
  seed: 7,
};

/** a small deterministic generator, so a fit repeats exactly */
function generator(seed: number): () => number {
  let state = seed >>> 0 || 1;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296 - 0.5) * 2;
  };
}

/**
 * The prediction, and the per-vector sums it needs, which the gradient
 * step reuses. The pairing is worked out in one pass over the features
 * rather than over every pair of them.
 */
function forward(
  model: Factorization,
  features: string[],
): { value: number; sums: Float64Array } {
  const sums = new Float64Array(model.rank);
  let squares = 0;
  let value = model.bias;

  for (const feature of features) {
    value += model.weight.get(feature) ?? 0;
    const vector = model.vector.get(feature);

    if (!vector) {
      continue;
    }

    for (let f = 0; f < model.rank; f++) {
      sums[f] = sums[f]! + vector[f]!;
      squares += vector[f]! * vector[f]!;
    }
  }

  let paired = 0;

  for (let f = 0; f < model.rank; f++) {
    paired += sums[f]! * sums[f]!;
  }

  return { value: value + (paired - squares) / 2, sums };
}

export function predict(model: Factorization, features: string[]): number {
  return forward(model, features).value * model.scale + model.centre;
}

export function fitFactorization(
  examples: Example[],
  settings: FitSettings = FIT_DEFAULTS,
): Factorization {
  const random = generator(settings.seed);
  // Fitted on a standardised target. Yards run from a loss of twenty
  // to a gain of ninety, and a step size that suits that spread with
  // ten entities on a play sends the whole thing to infinity.
  const centre =
    examples.reduce((sum, e) => sum + e.target, 0) / Math.max(1, examples.length);
  const spread = Math.sqrt(
    examples.reduce((sum, e) => sum + (e.target - centre) ** 2, 0) /
      Math.max(1, examples.length),
  ) || 1;
  const model: Factorization = {
    bias: 0,
    centre,
    scale: spread,
    weight: new Map(),
    vector: new Map(),
    rank: settings.rank,
  };

  for (const example of examples) {
    for (const feature of example.features) {
      if (model.vector.has(feature)) {
        continue;
      }

      const vector = new Float64Array(settings.rank);

      for (let f = 0; f < settings.rank; f++) {
        vector[f] = random() * 0.05;
      }

      model.weight.set(feature, 0);
      model.vector.set(feature, vector);
    }
  }

  const order = examples.map((_, i) => i);

  for (let pass = 0; pass < settings.passes; pass++) {
    // shuffle, so the order of the file does not become part of the fit
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.abs(random()) * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }

    // ease the step down as it settles
    const rate = settings.rate / (1 + pass * 0.4);

    for (const index of order) {
      const example = examples[index]!;
      const { value, sums } = forward(model, example.features);
      // clipped, so one wild play cannot throw the whole fit
      const error = Math.max(-4, Math.min(4, value - (example.target - centre) / spread));
      model.bias -= rate * error;

      for (const feature of example.features) {
        const weight = model.weight.get(feature)!;
        model.weight.set(
          feature, weight - rate * (error + settings.penalty * weight),
        );
        const vector = model.vector.get(feature)!;

        for (let f = 0; f < model.rank; f++) {
          // this entity's part of the pairing is everyone else's sum
          const others = sums[f]! - vector[f]!;
          vector[f] = vector[f]! -
            rate * (error * others + settings.penalty * vector[f]!);
        }
      }
    }
  }

  if (!Number.isFinite(model.bias)) {
    throw new Error(
      "the fit ran away; try a smaller rate or a heavier penalty",
    );
  }

  return model;
}

/**
 * How strongly two entities pull together, which is what says an
 * interaction was found. Reading these back is how a fit gets checked
 * against something already known.
 */
export function affinity(
  model: Factorization,
  left: string,
  right: string,
): number {
  const a = model.vector.get(left);
  const b = model.vector.get(right);

  if (!a || !b) {
    return 0;
  }

  let total = 0;

  for (let f = 0; f < model.rank; f++) {
    total += a[f]! * b[f]!;
  }

  return total;
}

/**
 * Learned descriptions of the things on a play, trained against
 * several questions at once.
 *
 * The factorized model could only combine two entities at a time,
 * through an inner product, and it could not bend a response. This
 * pools the entities' vectors and pushes them through a hidden layer,
 * so a coach with this personnel in this situation is representable
 * rather than being the sum of three pairs.
 *
 * Several heads share one set of vectors on purpose. Fitting yards
 * alone gave each entity one question's worth of evidence, which was
 * not enough; four questions give the same vectors four times as much.
 */

export interface Task {
  name: string;
  /** the value to predict, or undefined when this play does not say */
  of: (index: number) => number | undefined;
}

export interface NetSettings {
  width: number;
  hidden: number;
  passes: number;
  rate: number;
  penalty: number;
  seed: number;
}

export const NET_DEFAULTS: NetSettings = {
  width: 12,
  hidden: 16,
  passes: 8,
  rate: 0.03,
  penalty: 1e-6,
  seed: 11,
};

export interface EntityNet {
  vector: Map<string, Float64Array>;
  /** hidden layer, as [width][hidden] */
  toHidden: Float64Array[];
  hiddenBias: Float64Array;
  /** one row of [hidden] per task, and its bias */
  heads: Map<string, { weights: Float64Array; bias: number }>;
  /** each task's centre and spread, for putting answers back on scale */
  scaling: Map<string, { centre: number; spread: number }>;
  settings: NetSettings;
}

function generator(seed: number): () => number {
  let state = seed >>> 0 || 1;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296 - 0.5) * 2;
  };
}

/** pooled vector, hidden activations, and how many entities were on it */
function forward(net: EntityNet, features: string[]) {
  const { width, hidden } = net.settings;
  const pooled = new Float64Array(width);
  let seen = 0;

  for (const feature of features) {
    const vector = net.vector.get(feature);

    if (!vector) {
      continue;
    }

    seen++;

    for (let k = 0; k < width; k++) {
      pooled[k] = pooled[k]! + vector[k]!;
    }
  }

  // mean rather than sum, so a play with more entities on it does not
  // arrive at the hidden layer already louder
  for (let k = 0; k < width; k++) {
    pooled[k] = pooled[k]! / Math.max(1, seen);
  }

  const activation = new Float64Array(hidden);

  for (let h = 0; h < hidden; h++) {
    let total = net.hiddenBias[h]!;

    for (let k = 0; k < width; k++) {
      total += pooled[k]! * net.toHidden[k]![h]!;
    }

    activation[h] = Math.tanh(total);
  }

  return { pooled, activation, seen };
}

export function predict(net: EntityNet, features: string[], task: string): number {
  const head = net.heads.get(task);
  const scale = net.scaling.get(task);

  if (!head || !scale) {
    return 0;
  }

  const { activation } = forward(net, features);
  let total = head.bias;

  for (let h = 0; h < net.settings.hidden; h++) {
    total += activation[h]! * head.weights[h]!;
  }

  return total * scale.spread + scale.centre;
}

export function fitEntityNet(
  plays: string[][],
  tasks: Task[],
  settings: NetSettings = NET_DEFAULTS,
): EntityNet {
  const random = generator(settings.seed);
  const { width, hidden } = settings;
  const net: EntityNet = {
    vector: new Map(),
    toHidden: Array.from({ length: width }, () => {
      const row = new Float64Array(hidden);
      for (let h = 0; h < hidden; h++) row[h] = random() * 0.3;
      return row;
    }),
    hiddenBias: new Float64Array(hidden),
    heads: new Map(),
    scaling: new Map(),
    settings,
  };

  for (const features of plays) {
    for (const feature of features) {
      if (net.vector.has(feature)) {
        continue;
      }

      const vector = new Float64Array(width);
      for (let k = 0; k < width; k++) vector[k] = random() * 0.1;
      net.vector.set(feature, vector);
    }
  }

  for (const task of tasks) {
    const values: number[] = [];

    for (let i = 0; i < plays.length; i++) {
      const value = task.of(i);
      if (value !== undefined) values.push(value);
    }

    const centre = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    const spread = Math.sqrt(
      values.reduce((a, b) => a + (b - centre) ** 2, 0) / Math.max(1, values.length),
    ) || 1;
    net.scaling.set(task.name, { centre, spread });
    const weights = new Float64Array(hidden);
    for (let h = 0; h < hidden; h++) weights[h] = random() * 0.1;
    net.heads.set(task.name, { weights, bias: 0 });
  }

  const order = plays.map((_, i) => i);

  for (let pass = 0; pass < settings.passes; pass++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.abs(random()) * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }

    const rate = settings.rate / (1 + pass * 0.5);

    for (const index of order) {
      const features = plays[index]!;
      const { pooled, activation, seen } = forward(net, features);
      const backToActivation = new Float64Array(hidden);

      for (const task of tasks) {
        const wanted = task.of(index);

        if (wanted === undefined) {
          continue;
        }

        const head = net.heads.get(task.name)!;
        const scale = net.scaling.get(task.name)!;
        let said = head.bias;

        for (let h = 0; h < hidden; h++) {
          said += activation[h]! * head.weights[h]!;
        }

        const error = Math.max(
          -4, Math.min(4, said - (wanted - scale.centre) / scale.spread),
        );
        head.bias -= rate * error;

        for (let h = 0; h < hidden; h++) {
          backToActivation[h] = backToActivation[h]! + error * head.weights[h]!;
          head.weights[h] = head.weights[h]! -
            rate * (error * activation[h]! + settings.penalty * head.weights[h]!);
        }
      }

      // back through the tanh and the hidden layer
      const backToPooled = new Float64Array(width);

      for (let h = 0; h < hidden; h++) {
        const slope = backToActivation[h]! * (1 - activation[h]! * activation[h]!);
        net.hiddenBias[h] = net.hiddenBias[h]! - rate * slope;

        for (let k = 0; k < width; k++) {
          backToPooled[k] = backToPooled[k]! + slope * net.toHidden[k]![h]!;
          net.toHidden[k]![h] = net.toHidden[k]![h]! -
            rate * (slope * pooled[k]! + settings.penalty * net.toHidden[k]![h]!);
        }
      }

      // and out to each entity, sharing the pooled gradient between them
      const share = 1 / Math.max(1, seen);

      for (const feature of features) {
        const vector = net.vector.get(feature);

        if (!vector) {
          continue;
        }

        for (let k = 0; k < width; k++) {
          vector[k] = vector[k]! -
            rate * (backToPooled[k]! * share + settings.penalty * vector[k]!);
        }
      }
    }
  }

  if (!Number.isFinite(net.hiddenBias[0]!)) {
    throw new Error("the fit ran away; try a smaller rate or a heavier penalty");
  }

  return net;
}

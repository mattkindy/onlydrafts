/**
 * The same network, fed descriptions rather than inventing them.
 *
 * entityNet gave every player a vector of free numbers and learned
 * them from the plays, which needs more seasons than exist. Here each
 * entity arrives already described, by height and draft pick and how
 * he has been used, and the only thing learned is how to turn a
 * description into something the task can use.
 *
 * That leaves far less to fit, and it answers for a man nobody has
 * seen: a rookie has a description on draft day, so he projects the
 * same way everyone else does rather than falling back on an average.
 */

export interface Described {
  /** the entity's own numbers, all of one length per kind */
  kind: string;
  values: Float64Array;
}

export interface Task {
  name: string;
  of: (index: number) => number | undefined;
}

export interface DescribedSettings {
  width: number;
  hidden: number;
  passes: number;
  rate: number;
  penalty: number;
  seed: number;
}

export const DESCRIBED_DEFAULTS: DescribedSettings = {
  width: 12,
  hidden: 20,
  passes: 8,
  rate: 0.02,
  penalty: 1e-6,
  seed: 5,
};

export interface DescribedNet {
  /** one projection per kind of entity, as [inputs][width] */
  project: Map<string, Float64Array[]>;
  toHidden: Float64Array[];
  hiddenBias: Float64Array;
  heads: Map<string, { weights: Float64Array; bias: number }>;
  scaling: Map<string, { centre: number; spread: number }>;
  settings: DescribedSettings;
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

/** each entity's description projected, then averaged over the play */
function forward(net: DescribedNet, on: Described[]) {
  const { width, hidden } = net.settings;
  const pooled = new Float64Array(width);
  let seen = 0;

  for (const entity of on) {
    const projection = net.project.get(entity.kind);

    if (!projection) {
      continue;
    }

    seen++;

    for (let i = 0; i < entity.values.length && i < projection.length; i++) {
      const value = entity.values[i]!;

      if (value === 0) {
        continue;
      }

      for (let k = 0; k < width; k++) {
        pooled[k] = pooled[k]! + value * projection[i]![k]!;
      }
    }
  }

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

export function predict(net: DescribedNet, on: Described[], task: string): number {
  const head = net.heads.get(task);
  const scale = net.scaling.get(task);

  if (!head || !scale) {
    return 0;
  }

  const { activation } = forward(net, on);
  let total = head.bias;

  for (let h = 0; h < net.settings.hidden; h++) {
    total += activation[h]! * head.weights[h]!;
  }

  return total * scale.spread + scale.centre;
}

export function fitDescribedNet(
  plays: Described[][],
  tasks: Task[],
  settings: DescribedSettings = DESCRIBED_DEFAULTS,
): DescribedNet {
  const random = generator(settings.seed);
  const { width, hidden } = settings;
  const widthOf = new Map<string, number>();

  for (const play of plays) {
    for (const entity of play) {
      widthOf.set(
        entity.kind,
        Math.max(widthOf.get(entity.kind) ?? 0, entity.values.length),
      );
    }
  }

  const net: DescribedNet = {
    project: new Map(
      [...widthOf].map(([kind, inputs]) => [
        kind,
        Array.from({ length: inputs }, () => {
          const row = new Float64Array(width);
          for (let k = 0; k < width; k++) row[k] = random() * 0.2;
          return row;
        }),
      ]),
    ),
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
      const on = plays[index]!;
      const { pooled, activation, seen } = forward(net, on);
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

      // and back into each projection, which is the only thing about an
      // entity that gets learned; its description does not move
      const share = 1 / Math.max(1, seen);

      for (const entity of on) {
        const projection = net.project.get(entity.kind);

        if (!projection) {
          continue;
        }

        for (let i = 0; i < entity.values.length && i < projection.length; i++) {
          const value = entity.values[i]!;

          if (value === 0) {
            continue;
          }

          for (let k = 0; k < width; k++) {
            projection[i]![k] = projection[i]![k]! -
              rate * (backToPooled[k]! * value * share +
                settings.penalty * projection[i]![k]!);
          }
        }
      }
    }
  }

  return net;
}

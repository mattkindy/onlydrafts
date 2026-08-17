/**
 * Descriptions combined so that who contributed what survives.
 *
 * describedNet averages every entity on a play into one vector before
 * anything is learned from it, and that average cannot tell an offence
 * attribute from a defence one. Every time a matchup mattered, the fix
 * was to hand another column to a ridge by hand.
 *
 * Here each kind of entity keeps its own slot, and the products of
 * those slots go into the fit beside them. An offence attribute times a
 * defence attribute is a term the model can weigh on its own, so a
 * pairing worth more than its parts is something it can find.
 */

export interface Described {
  kind: string;
  values: Float64Array;
}

export interface Task {
  name: string;
  of: (index: number) => number | undefined;
}

export interface InteractionSettings {
  /** how many numbers each kind is projected down to */
  width: number;
  hidden: number;
  passes: number;
  rate: number;
  penalty: number;
  seed: number;
}

export const INTERACTION_DEFAULTS: InteractionSettings = {
  width: 8,
  hidden: 24,
  passes: 8,
  rate: 0.02,
  penalty: 1e-6,
  seed: 7,
};

export interface InteractionNet {
  /** the kinds in a fixed order, since the slots are laid out by it */
  kinds: string[];
  project: Map<string, Float64Array[]>;
  toHidden: Float64Array[];
  hiddenBias: Float64Array;
  heads: Map<string, { weights: Float64Array; bias: number }>;
  scaling: Map<string, { centre: number; spread: number }>;
  settings: InteractionSettings;
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

/** every pair of kinds, in the order their products are laid out */
function pairsOf(kinds: string[]): [number, number][] {
  const pairs: [number, number][] = [];

  for (let a = 0; a < kinds.length; a++) {
    for (let b = a + 1; b < kinds.length; b++) {
      pairs.push([a, b]);
    }
  }

  return pairs;
}

export function inputWidth(settings: InteractionSettings, kinds: number): number {
  return settings.width * (kinds + (kinds * (kinds - 1)) / 2);
}

/**
 * One slot per kind, then the products. The slots come first so a kind
 * can be used on its own as well as in a pairing.
 */
function forward(net: InteractionNet, on: Described[]) {
  const { width, hidden } = net.settings;
  const slots = net.kinds.map(() => new Float64Array(width));
  const seen = net.kinds.map(() => 0);

  for (const entity of on) {
    const slot = net.kinds.indexOf(entity.kind);
    const projection = net.project.get(entity.kind);

    if (slot === -1 || !projection) {
      continue;
    }

    seen[slot] = seen[slot]! + 1;

    for (let i = 0; i < entity.values.length && i < projection.length; i++) {
      const value = entity.values[i]!;

      if (value === 0) {
        continue;
      }

      for (let k = 0; k < width; k++) {
        slots[slot]![k] = slots[slot]![k]! + value * projection[i]![k]!;
      }
    }
  }

  // a kind with several men in it is their average, so a team with more
  // players described does not weigh more for that reason alone
  for (let s = 0; s < slots.length; s++) {
    const count = Math.max(1, seen[s]!);

    for (let k = 0; k < width; k++) {
      slots[s]![k] = slots[s]![k]! / count;
    }
  }

  const pairs = pairsOf(net.kinds);
  const row = new Float64Array(inputWidth(net.settings, net.kinds.length));
  let at = 0;

  for (const slot of slots) {
    for (let k = 0; k < width; k++) {
      row[at++] = slot[k]!;
    }
  }

  for (const [a, b] of pairs) {
    for (let k = 0; k < width; k++) {
      row[at++] = slots[a]![k]! * slots[b]![k]!;
    }
  }

  const activation = new Float64Array(hidden);

  for (let h = 0; h < hidden; h++) {
    let total = net.hiddenBias[h]!;

    for (let k = 0; k < row.length; k++) {
      total += row[k]! * net.toHidden[k]![h]!;
    }

    activation[h] = Math.tanh(total);
  }

  return { slots, seen, row, activation, pairs };
}

export function predict(net: InteractionNet, on: Described[], task: string): number {
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

export function fitInteractionNet(
  plays: Described[][],
  tasks: Task[],
  settings: InteractionSettings = INTERACTION_DEFAULTS,
): InteractionNet {
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

  const kinds = [...widthOf.keys()].sort();
  const inputs = inputWidth(settings, kinds.length);

  const net: InteractionNet = {
    kinds,
    project: new Map(
      kinds.map((kind) => [
        kind,
        Array.from({ length: widthOf.get(kind)! }, () => {
          const row = new Float64Array(width);
          for (let k = 0; k < width; k++) row[k] = random() * 0.2;
          return row;
        }),
      ]),
    ),
    toHidden: Array.from({ length: inputs }, () => {
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
      const { slots, seen, row, activation, pairs } = forward(net, on);
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

      const backToRow = new Float64Array(row.length);

      for (let h = 0; h < hidden; h++) {
        const slope = backToActivation[h]! * (1 - activation[h]! * activation[h]!);
        net.hiddenBias[h] = net.hiddenBias[h]! - rate * slope;

        for (let k = 0; k < row.length; k++) {
          backToRow[k] = backToRow[k]! + slope * net.toHidden[k]![h]!;
          net.toHidden[k]![h] = net.toHidden[k]![h]! -
            rate * (slope * row[k]! + settings.penalty * net.toHidden[k]![h]!);
        }
      }

      // A slot is used on its own and in every pairing it belongs to,
      // so what comes back to it is the sum over all of them, and a
      // product sends the other slot's value through as the multiplier.
      const backToSlot = net.kinds.map(() => new Float64Array(width));
      let at = 0;

      for (let s = 0; s < net.kinds.length; s++) {
        for (let k = 0; k < width; k++) {
          backToSlot[s]![k] = backToSlot[s]![k]! + backToRow[at++]!;
        }
      }

      for (const [a, b] of pairs) {
        for (let k = 0; k < width; k++) {
          const back = backToRow[at++]!;
          backToSlot[a]![k] = backToSlot[a]![k]! + back * slots[b]![k]!;
          backToSlot[b]![k] = backToSlot[b]![k]! + back * slots[a]![k]!;
        }
      }

      for (const entity of on) {
        const slot = net.kinds.indexOf(entity.kind);
        const projection = net.project.get(entity.kind);

        if (slot === -1 || !projection) {
          continue;
        }

        const share = 1 / Math.max(1, seen[slot]!);

        for (let i = 0; i < entity.values.length && i < projection.length; i++) {
          const value = entity.values[i]!;

          if (value === 0) {
            continue;
          }

          for (let k = 0; k < width; k++) {
            projection[i]![k] = projection[i]![k]! -
              rate * (backToSlot[slot]![k]! * value * share +
                settings.penalty * projection[i]![k]!);
          }
        }
      }
    }
  }

  return net;
}

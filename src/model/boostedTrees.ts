/**
 * Boosted regression trees, for finding interactions nobody named.
 *
 * The interaction network multiplies one side's attributes by the
 * other's, which finds a pairing worth more than its parts as long as
 * the effect is smooth. It cannot easily represent a gate: what a back
 * did last season counts for less once his coordinator has gone, and
 * that is a split rather than a product.
 *
 * A tree splits by nature, so what it chooses to split on says which
 * conditions matter. Used here to find them, not to replace the walk,
 * which needs a distribution of yards where this gives one number.
 */

export interface TreeSettings {
  /** how many trees, each correcting what the ones before it left */
  trees: number;
  /** how deep each may go, which caps how many things can interact */
  depth: number;
  /** how much of each tree's correction is taken */
  rate: number;
  /** rows a leaf must keep, which stops it fitting single plays */
  leastInLeaf: number;
  /** how many buckets each feature is cut into before splitting */
  bins: number;
  seed: number;
}

export const TREE_DEFAULTS: TreeSettings = {
  trees: 200, depth: 4, rate: 0.06, leastInLeaf: 200, bins: 32, seed: 11,
};

interface Node {
  /** which feature this asks about, or -1 at a leaf */
  feature: number;
  /** rows at or below this bucket go left */
  upTo: number;
  left: number;
  right: number;
  value: number;
}

export interface Forest {
  trees: Node[][];
  /** where each feature's buckets start, so a new row can be binned */
  edges: number[][];
  base: number;
  rate: number;
  names: string[];
  /** how much each feature took off the error, summed over every split */
  credit: number[];
  /** and the same for each pair that appeared together down one path */
  pairCredit: Map<string, number>;
}

/** the cut points that put a feature's values into even buckets */
function edgesFor(values: number[], bins: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const edges: number[] = [];

  for (let i = 1; i < bins; i++) {
    const at = sorted[Math.floor((i / bins) * sorted.length)];

    if (at !== undefined && (edges.length === 0 || at > edges[edges.length - 1]!)) {
      edges.push(at);
    }
  }

  return edges;
}

const bucketOf = (value: number, edges: number[]): number => {
  let low = 0;
  let high = edges.length;

  while (low < high) {
    const mid = (low + high) >> 1;

    if (value <= edges[mid]!) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low;
};

export interface TreeInput {
  /** one row per play, each the same length as names */
  rows: number[][];
  target: number[];
  names: string[];
  settings?: TreeSettings;
}

export function fitForest(input: TreeInput): Forest {
  const settings = input.settings ?? TREE_DEFAULTS;
  const width = input.names.length;
  const count = input.rows.length;
  const edges: number[][] = [];
  const binned: Uint8Array[] = [];

  for (let f = 0; f < width; f++) {
    const column = input.rows.map((row) => row[f] ?? 0);
    const own = edgesFor(column, settings.bins);
    edges.push(own);
    const into = new Uint8Array(count);

    for (let i = 0; i < count; i++) {
      into[i] = bucketOf(column[i]!, own);
    }

    binned.push(into);
  }

  const base = input.target.reduce((a, b) => a + b, 0) / Math.max(1, count);
  const said = new Float64Array(count).fill(base);
  const credit = new Array<number>(width).fill(0);
  const pairCredit = new Map<string, number>();
  const trees: Node[][] = [];
  const where = new Int32Array(count);

  for (let t = 0; t < settings.trees; t++) {
    const left = new Float64Array(count);

    for (let i = 0; i < count; i++) {
      left[i] = input.target[i]! - said[i]!;
    }

    const nodes: Node[] = [];
    /** which features were asked about on the way to each node */
    const asked: number[][] = [[]];
    nodes.push({ feature: -1, upTo: 0, left: -1, right: -1, value: 0 });
    where.fill(0);
    let frontier = [0];

    for (let level = 0; level < settings.depth; level++) {
      const next: number[] = [];

      for (const node of frontier) {
        const mine: number[] = [];
        let sum = 0;

        for (let i = 0; i < count; i++) {
          if (where[i] === node) {
            mine.push(i);
            sum += left[i]!;
          }
        }

        nodes[node]!.value = sum / Math.max(1, mine.length);

        if (mine.length < 2 * settings.leastInLeaf) {
          continue;
        }

        let bestGain = 0;
        let bestFeature = -1;
        let bestUpTo = 0;

        for (let f = 0; f < width; f++) {
          const buckets = edges[f]!.length + 1;
          const sums = new Float64Array(buckets);
          const counts = new Float64Array(buckets);

          for (const i of mine) {
            sums[binned[f]![i]!]! += left[i]!;
            counts[binned[f]![i]!]!++;
          }

          let leftSum = 0;
          let leftCount = 0;

          for (let b = 0; b < buckets - 1; b++) {
            leftSum += sums[b]!;
            leftCount += counts[b]!;
            const rightSum = sum - leftSum;
            const rightCount = mine.length - leftCount;

            if (leftCount < settings.leastInLeaf || rightCount < settings.leastInLeaf) {
              continue;
            }

            // how much squared error this split takes off
            const gain = (leftSum * leftSum) / leftCount +
              (rightSum * rightSum) / rightCount -
              (sum * sum) / mine.length;

            if (gain > bestGain) {
              bestGain = gain;
              bestFeature = f;
              bestUpTo = b;
            }
          }
        }

        if (bestFeature === -1) {
          continue;
        }

        credit[bestFeature]! += bestGain;

        for (const already of asked[node]!) {
          if (already === bestFeature) {
            continue;
          }

          const pair = already < bestFeature
            ? `${input.names[already]} with ${input.names[bestFeature]}`
            : `${input.names[bestFeature]} with ${input.names[already]}`;
          pairCredit.set(pair, (pairCredit.get(pair) ?? 0) + bestGain);
        }

        const leftAt = nodes.length;
        const rightAt = nodes.length + 1;
        nodes.push({ feature: -1, upTo: 0, left: -1, right: -1, value: 0 });
        nodes.push({ feature: -1, upTo: 0, left: -1, right: -1, value: 0 });
        asked[leftAt] = [...asked[node]!, bestFeature];
        asked[rightAt] = [...asked[node]!, bestFeature];
        nodes[node]!.feature = bestFeature;
        nodes[node]!.upTo = bestUpTo;
        nodes[node]!.left = leftAt;
        nodes[node]!.right = rightAt;

        for (const i of mine) {
          where[i] = binned[bestFeature]![i]! <= bestUpTo ? leftAt : rightAt;
        }

        next.push(leftAt, rightAt);
      }

      frontier = next;

      if (!frontier.length) {
        break;
      }
    }

    for (let i = 0; i < count; i++) {
      said[i] = said[i]! + settings.rate * nodes[where[i]!]!.value;
    }

    trees.push(nodes);
  }

  return {
    trees, edges, base, rate: settings.rate, names: input.names,
    credit, pairCredit,
  };
}

export function predictForest(forest: Forest, row: number[]): number {
  let said = forest.base;

  for (const nodes of forest.trees) {
    let at = 0;

    while (nodes[at]!.feature !== -1) {
      const bucket = bucketOf(
        row[nodes[at]!.feature] ?? 0, forest.edges[nodes[at]!.feature]!,
      );
      at = bucket <= nodes[at]!.upTo ? nodes[at]!.left : nodes[at]!.right;
    }

    said += forest.rate * nodes[at]!.value;
  }

  return said;
}

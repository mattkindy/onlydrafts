/**
 * Small gradient-boosted regression trees for a few thousand examples
 * and a couple dozen features. Squared error, exact split search,
 * depth-limited trees, shrinkage. Deterministic, no sampling, so runs
 * reproduce.
 */

export interface GbmOptions {
  trees: number;
  depth: number;
  rate: number;
  minLeaf: number;
}

interface Node {
  feature?: number;
  threshold?: number;
  left?: Node;
  right?: Node;
  value: number;
}

export interface GbmModel {
  base: number;
  rate: number;
  trees: Node[];
}

function mean(values: number[]): number {
  return values.reduce((s, x) => s + x, 0) / values.length;
}

function buildTree(
  X: number[][],
  residuals: number[],
  indices: number[],
  depth: number,
  minLeaf: number,
): Node {
  const value = mean(indices.map((i) => residuals[i]!));

  if (depth === 0 || indices.length < 2 * minLeaf) {
    return { value };
  }

  const d = X[0]!.length;
  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;

  const total = indices.reduce((s, i) => s + residuals[i]!, 0);

  for (let f = 0; f < d; f++) {
    const sorted = [...indices].sort((a, b) => X[a]![f]! - X[b]![f]!);
    let leftSum = 0;

    for (let k = 0; k < sorted.length - 1; k++) {
      leftSum += residuals[sorted[k]!]!;

      if (X[sorted[k]!]![f]! === X[sorted[k + 1]!]![f]!) {
        continue;
      }

      const leftCount = k + 1;
      const rightCount = sorted.length - leftCount;

      if (leftCount < minLeaf || rightCount < minLeaf) {
        continue;
      }

      const rightSum = total - leftSum;
      const gain =
        (leftSum * leftSum) / leftCount +
        (rightSum * rightSum) / rightCount -
        (total * total) / sorted.length;

      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = (X[sorted[k]!]![f]! + X[sorted[k + 1]!]![f]!) / 2;
      }
    }
  }

  if (bestFeature === -1) {
    return { value };
  }

  const leftIdx = indices.filter((i) => X[i]![bestFeature]! <= bestThreshold);
  const rightIdx = indices.filter((i) => X[i]![bestFeature]! > bestThreshold);

  return {
    feature: bestFeature,
    threshold: bestThreshold,
    left: buildTree(X, residuals, leftIdx, depth - 1, minLeaf),
    right: buildTree(X, residuals, rightIdx, depth - 1, minLeaf),
    value,
  };
}

function treePredict(node: Node, row: number[]): number {
  if (node.feature === undefined) {
    return node.value;
  }

  return row[node.feature]! <= node.threshold!
    ? treePredict(node.left!, row)
    : treePredict(node.right!, row);
}

export function fitGbm(
  X: number[][],
  y: number[],
  options: GbmOptions,
): GbmModel {
  const base = mean(y);
  const predictions = new Array<number>(y.length).fill(base);
  const indices = Array.from({ length: y.length }, (_, i) => i);
  const trees: Node[] = [];

  for (let t = 0; t < options.trees; t++) {
    const residuals = y.map((target, i) => target - predictions[i]!);
    const tree = buildTree(X, residuals, indices, options.depth, options.minLeaf);
    trees.push(tree);

    for (let i = 0; i < y.length; i++) {
      predictions[i]! += options.rate * treePredict(tree, X[i]!);
    }
  }

  return { base, rate: options.rate, trees };
}

export function predictGbm(model: GbmModel, row: number[]): number {
  let value = model.base;

  for (const tree of model.trees) {
    value += model.rate * treePredict(tree, row);
  }

  return value;
}

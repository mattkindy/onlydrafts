/**
 * Ridge regression by the normal equations: solve (X'X + lambda I) w = X'y.
 * Feature counts here are tiny (around ten), so a direct Gaussian
 * elimination solve is plenty.
 */

export function fitRidge(
  X: number[][],
  y: number[],
  lambda: number,
): number[] {
  const n = X.length;
  const d = X[0]?.length ?? 0;

  if (n === 0 || d === 0 || n !== y.length) {
    throw new Error(`fitRidge got ${n} rows, ${d} columns, ${y.length} targets`);
  }

  const A: number[][] = Array.from({ length: d }, () => new Array<number>(d + 1).fill(0));

  for (let i = 0; i < n; i++) {
    const row = X[i]!;

    for (let a = 0; a < d; a++) {
      for (let b = 0; b < d; b++) {
        A[a]![b]! += row[a]! * row[b]!;
      }

      A[a]![d]! += row[a]! * y[i]!;
    }
  }

  for (let a = 0; a < d; a++) {
    A[a]![a]! += lambda;
  }

  return solve(A, d);
}

export function predictRidge(weights: number[], features: number[]): number {
  let sum = 0;

  for (let i = 0; i < weights.length; i++) {
    sum += weights[i]! * (features[i] ?? 0);
  }

  return sum;
}

/** Gaussian elimination with partial pivoting on an augmented matrix. */
function solve(A: number[][], d: number): number[] {
  for (let col = 0; col < d; col++) {
    let pivot = col;

    for (let row = col + 1; row < d; row++) {
      if (Math.abs(A[row]![col]!) > Math.abs(A[pivot]![col]!)) {
        pivot = row;
      }
    }

    [A[col], A[pivot]] = [A[pivot]!, A[col]!];

    const lead = A[col]![col]!;

    if (Math.abs(lead) < 1e-12) {
      throw new Error("singular system; increase lambda");
    }

    for (let row = 0; row < d; row++) {
      if (row === col) {
        continue;
      }

      const factor = A[row]![col]! / lead;

      for (let k = col; k <= d; k++) {
        A[row]![k]! -= factor * A[col]![k]!;
      }
    }
  }

  return Array.from({ length: d }, (_, i) => A[i]![d]! / A[i]![i]!);
}

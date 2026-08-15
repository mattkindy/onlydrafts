/** standard normal draw by Box-Muller, fed from a uniform rng */
export function normalDraw(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** standard normal CDF via the Abramowitz and Stegun erf approximation */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
  const p = 1 - tail * poly;
  return z >= 0 ? p : 1 - p;
}

/** mulberry32: a small seeded generator so simulations reproduce exactly */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** how many of a rare thing happened, by Knuth's product of uniforms */
export function poisson(mean: number, uniform: () => number): number {
  if (mean <= 0) {
    return 0;
  }

  const limit = Math.exp(-mean);
  let count = 0;
  let product = uniform();

  while (product > limit) {
    count++;
    product *= uniform();
  }

  return count;
}

/** one draw from a bell centred on zero, off Box and Muller's pair */
export const standardNormal = (uniform: () => number): number =>
  Math.sqrt(-2 * Math.log(Math.max(1e-12, uniform()))) *
  Math.cos(2 * Math.PI * uniform());

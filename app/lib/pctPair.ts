/**
 * Two opposed odds as whole percentages that add up to 100. Rounding
 * each side on its own says 64% and 37% for a 63.5 game, so the favoured
 * side is rounded and the other side is what is left.
 */
export function wholePair(odds: number): [number, number] {
  const favoured = Math.round(100 * Math.max(odds, 1 - odds));
  const pair: [number, number] = [favoured, 100 - favoured];

  return odds >= 0.5 ? pair : [pair[1], pair[0]];
}

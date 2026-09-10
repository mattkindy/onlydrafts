/**
 * Which seasons a script was asked for. The fetch and the aggregate
 * steps both take `--seasons`, either a comma list like `2021,2026` or
 * a range like `2021-2025`, and fall back to whatever the script wants
 * when nobody says.
 */

export function parseSeasonList(
  arg: string | undefined,
  fallback: number[],
): number[] {
  if (!arg) {
    return fallback;
  }

  const range = /^(\d{4})-(\d{4})$/.exec(arg);

  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);

    return Array.from(
      { length: Math.max(0, to - from + 1) },
      (_, i) => from + i,
    );
  }

  return arg.split(",").map(Number).filter((season) => Number.isFinite(season));
}

export function seasonsAsked(argv: string[], fallback: number[]): number[] {
  const at = argv.indexOf("--seasons");

  return parseSeasonList(at === -1 ? undefined : argv[at + 1], fallback);
}

/**
 * A kicker's season from the kicks his side actually gets.
 *
 * Last season's points say what he was handed, not what he will be.
 * The walk plays the schedule out and every drive that stalls in range
 * becomes an attempt from a particular yard line, so the situation
 * that produces a kick is modelled rather than averaged: a side behind
 * late on a stalled drive kicks, one that scores converts instead.
 *
 * His own accuracy is then applied band by band, pulled toward what
 * every kicker makes from there until he has taken enough of them.
 */

export interface KickerHistory {
  attempts: number;
  made: number;
  /** attempts and makes in each band, in the order of BANDS */
  byBand: { attempts: number; made: number }[];
  extraPointRate: number;
}

/** the bands a league prices a kick in */
export const BANDS = [
  { name: "0_19", upTo: 19 },
  { name: "20_29", upTo: 29 },
  { name: "30_39", upTo: 39 },
  { name: "40_49", upTo: 49 },
  { name: "50_59", upTo: 59 },
  { name: "60p", upTo: 99 },
];

/** what everyone makes from each band, near enough */
const LEAGUE_MAKES = [0.98, 0.97, 0.94, 0.85, 0.68, 0.4];
const STEADY_AT = 12;

export const bandOf = (yards: number) =>
  BANDS.findIndex((band) => yards <= band.upTo);

/**
 * What he does in a game, in the categories a league pays for, from
 * the attempts his side is expected to give him.
 */
export function kickerParts(
  him: KickerHistory,
  attemptYards: number[],
  touchdowns: number,
  games: number,
): Record<string, number> {
  const out: Record<string, number> = { fgmYds: 0, xpm: 0, xpmiss: 0 };

  for (const band of BANDS) {
    out[`fgm_${band.name}`] = 0;
    out[`fgmiss_${band.name}`] = 0;
  }

  const tally = new Map<number, number>();

  for (const yards of attemptYards) {
    const at = bandOf(yards);
    tally.set(at, (tally.get(at) ?? 0) + 1);
  }

  for (const [at, attempts] of tally) {
    const his = him.byBand[at] ?? { attempts: 0, made: 0 };
    const trust = his.attempts / (his.attempts + STEADY_AT);
    const makes = trust * (his.attempts > 0 ? his.made / his.attempts : 0) +
      (1 - trust) * (LEAGUE_MAKES[at] ?? 0.8);
    const band = BANDS[at]!;
    const perGame = attempts / games;
    out[`fgm_${band.name}`] = perGame * makes;
    out[`fgmiss_${band.name}`] = perGame * (1 - makes);
    // the yards a league pays by, from the middle of the band
    const middle = at === 0 ? 17 : Math.min(55, band.upTo - 4);
    out["fgmYds"] = (out["fgmYds"] ?? 0) + perGame * makes * middle;
  }

  out["xpm"] = (touchdowns / games) * him.extraPointRate;

  return out;
}

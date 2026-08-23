/**
 * A kicker's season played out game by game, so he gets the same thing
 * on his card as everyone else.
 *
 * The walk hands back every kick his side is expected to take across
 * the seasons it ran, as a flat list of yard lines with no game
 * boundaries. That is enough for what he averages and says nothing
 * about a good week against a bad one, which is most of what a drafter
 * wants from a kicker.
 *
 * So the games are put back: how many kicks a game comes from the rate
 * the walk produced, the yard lines are drawn from the ones it actually
 * generated, and his own accuracy by band decides each one.
 */

import { BANDS, bandOf, type KickerHistory } from "./kickerFromWalk.js";

/** what everyone makes from each band, near enough */
const LEAGUE_MAKES = [0.98, 0.97, 0.94, 0.85, 0.68, 0.4];
const STEADY_AT = 12;

/**
 * What a kick is worth while the board is being built. The page applies
 * whatever the connected league pays and moves the spread with it, so
 * these only have to be the same units the rest of the board is in.
 */
const AS_BUILT: Record<string, number> = {
  fgmYds: 0.1, xpm: 1, xpmiss: -1,
  fgmiss_0_19: -3, fgmiss_20_29: -2, fgmiss_30_39: -2,
  fgmiss_40_49: -1, fgmiss_50_59: -1, fgmiss_60p: 0,
};

export interface Spread {
  ev: number;
  q1: number;
  mid: number;
  q3: number;
  low: number;
  high: number;
}

export interface KickerSeason {
  /** one game of his, in the categories a league pays for */
  parts: Record<string, number>;
  /** what he scores in a game, and how those vary */
  game: Spread;
  /** and across a season, with the games he is expected to play */
  sim: Spread & { games: number };
}

/** how often he makes one from a band, leaning on the league until he has taken enough */
function makesFrom(him: KickerHistory, band: number): number {
  const his = him.byBand[band] ?? { attempts: 0, made: 0 };
  const trust = his.attempts / (his.attempts + STEADY_AT);

  return trust * (his.attempts > 0 ? his.made / his.attempts : 0) +
    (1 - trust) * (LEAGUE_MAKES[band] ?? 0.8);
}

const quantile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

const spread = (values: number[], places: number): Spread => {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n: number) => Number(n.toFixed(places));

  return {
    ev: round(values.reduce((s, v) => s + v, 0) / values.length),
    q1: round(quantile(sorted, 0.25)),
    mid: round(quantile(sorted, 0.5)),
    q3: round(quantile(sorted, 0.75)),
    low: round(quantile(sorted, 0.1)),
    high: round(quantile(sorted, 0.9)),
  };
};

/** a whole number of kicks this week, around the rate his side produces */
function howManyKicks(rate: number, rng: () => number): number {
  // Poisson by the usual product of uniforms, which is fast enough at
  // a rate near two and keeps the shape right at nought and at four
  const limit = Math.exp(-rate);
  let n = 0;
  let p = rng();

  while (p > limit && n < 8) {
    n++;
    p *= rng();
  }

  return n;
}

export function kickerSeason(
  him: KickerHistory,
  /** every yard line the walk kicked from, across all the seasons it ran */
  attemptYards: number[],
  /** and every touchdown, which is what an extra point follows */
  conversions: number,
  /** the game slots those were spread across */
  gameSlots: number,
  /** how many games he is expected to play */
  games: number,
  seasons: number,
  rng: () => number,
): KickerSeason {
  const kicksPerGame = attemptYards.length / Math.max(1, gameSlots);
  const touchdownsPerGame = conversions / Math.max(1, gameSlots);
  const perGame: number[] = [];
  const perSeason: number[] = [];
  const tally: Record<string, number> = { fgmYds: 0, xpm: 0, xpmiss: 0 };

  for (const band of BANDS) {
    tally[`fgm_${band.name}`] = 0;
    tally[`fgmiss_${band.name}`] = 0;
  }

  const played = Math.max(1, Math.round(games));

  for (let season = 0; season < seasons; season++) {
    let seasonPoints = 0;

    for (let game = 0; game < played; game++) {
      let points = 0;

      for (let k = howManyKicks(kicksPerGame, rng); k > 0; k--) {
        const yards = attemptYards[Math.floor(rng() * attemptYards.length)] ?? 35;
        const band = bandOf(yards);
        const made = rng() < makesFrom(him, band);
        const name = BANDS[band]!.name;

        if (made) {
          const middle = band === 0 ? 17 : Math.min(55, BANDS[band]!.upTo - 4);
          tally[`fgm_${name}`] = (tally[`fgm_${name}`] ?? 0) + 1;
          tally["fgmYds"] = (tally["fgmYds"] ?? 0) + middle;
          points += middle * AS_BUILT["fgmYds"]!;
        } else {
          tally[`fgmiss_${name}`] = (tally[`fgmiss_${name}`] ?? 0) + 1;
          points += AS_BUILT[`fgmiss_${name}`] ?? 0;
        }
      }

      for (let t = howManyKicks(touchdownsPerGame, rng); t > 0; t--) {
        if (rng() < him.extraPointRate) {
          tally["xpm"] = (tally["xpm"] ?? 0) + 1;
          points += AS_BUILT["xpm"]!;
        } else {
          tally["xpmiss"] = (tally["xpmiss"] ?? 0) + 1;
          points += AS_BUILT["xpmiss"]!;
        }
      }

      perGame.push(points);
      seasonPoints += points;
    }

    perSeason.push(seasonPoints);
  }

  const everyGame = seasons * played;
  const parts: Record<string, number> = {};

  for (const [part, n] of Object.entries(tally)) {
    parts[part] = Number((n / everyGame).toFixed(3));
  }

  // the same kicks counted the other ways a league counts them
  parts["fgm"] = BANDS.reduce((s, b) => s + (parts[`fgm_${b.name}`] ?? 0), 0);
  parts["fgmiss"] = BANDS.reduce((s, b) => s + (parts[`fgmiss_${b.name}`] ?? 0), 0);
  parts["fgm_50p"] = (parts["fgm_50_59"] ?? 0) + (parts["fgm_60p"] ?? 0);
  parts["fgmiss_50p"] = (parts["fgmiss_50_59"] ?? 0) + (parts["fgmiss_60p"] ?? 0);

  return {
    parts,
    game: spread(perGame, 1),
    sim: { ...spread(perSeason, 0), games: Number(games.toFixed(1)) },
  };
}

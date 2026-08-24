/**
 * The board in one league's terms.
 *
 * The file ships what each man does in a game and where rooms draft
 * him. Everything a league changes, what it pays, how many it starts,
 * how many teams there are, is applied here, so one board serves every
 * league and nothing has to be rebuilt when you connect a new one.
 *
 * This works on a copy and returns a new list. The page used to rescore
 * in place and keep the file's numbers in a shadow field so a second
 * pass would not compound the first. Recomputing from the file each
 * time removes the question.
 */

import { payFor, scoredHere, startedHere, type Pays, type Player } from "./scoring.ts";

export interface League {
  teams: number;
  slots?: string[] | null;
  pays: Pays;
}

/** the same weights the board is built with, quarterbacks apart */
const LEAN = { model: 0.106, share: 0.319, adp: 0.425, walk: 0.15 };
const QB_LEAN = { model: 0.03, share: 0, adp: 0.12, walk: 0.85 };

/** ordered among themselves, placed where the room drafts them */
const OWN_ORDER = new Set(["K", "DEF"]);

const WHERE = ["QB", "RB", "WR", "TE", "K", "DEF"];

/**
 * Which mock drafts to read. A point a catch moves receivers up, so a
 * ppr league reading standard mocks is reading the wrong room.
 */
export function roomFor(pays: Pays): "ppr" | "half" | "standard" {
  const perCatch = pays["rec"] ?? 0;

  return perCatch >= 0.75 ? "ppr" : perCatch >= 0.25 ? "half" : "standard";
}

function placesBy<T>(men: T[], by: (p: T) => number | null | undefined) {
  const at = new Map<number, number>();

  men
    .map((p, i) => ({ i, v: by(p) }))
    .filter((r): r is { i: number; v: number } => r.v !== null && r.v !== undefined)
    .sort((a, b) => b.v - a.v)
    .forEach((r, k) => at.set(r.i, k + 1));

  return at;
}

/**
 * What the last man the league would start at each position scores.
 * A league starting two quarterbacks has a better one left over, so
 * the gap to him is smaller and every quarterback is worth less.
 */
function lastStarter(
  men: Player[],
  started: Record<string, number>,
  of: (p: Player) => number | null | undefined,
) {
  const bar: Record<string, number> = {};

  for (const where of WHERE) {
    const ranked = men
      .filter((p) => p.position === where)
      .map(of)
      .filter((v): v is number => v !== null && v !== undefined)
      .sort((a, b) => b - a);
    bar[where] = ranked[Math.min(ranked.length - 1, started[where] ?? 0)] ?? 0;
  }

  return bar;
}

const scaled = (of: Record<string, number>, by: number, places: number) =>
  Object.fromEntries(Object.entries(of)
    .map(([at, n]) => [at, Number((n * by).toFixed(places))]));

export function rescore(players: Player[], league: League): Player[] {
  const { pays } = league;
  const room = roomFor(pays);
  const started = startedHere(league.slots, league.teams);

  const men = players.map((p): Player => {
    const market = p.adpBy?.[room];
    const ppg = Number(scoredHere(p, pays).toFixed(1));

    return {
      ...p,
      // what the simulation expects him to play, which is what prices a
      // fragile man against a durable one on the same average
      games: p.games ?? p.sim?.games ?? 17,
      ...(market ? { adp: market.adp, adpLow: market.low, adpHigh: market.high } : {}),
      ppg,
      ownPpg: ppg,
    };
  });

  const bar = lastStarter(men, started, (p) => p.ppg);

  /**
   * A man who misses four weeks gives you thirteen weeks of the gap to
   * a replacement and nothing for the other four, so a fragile player
   * and a durable one with the same average are priced apart.
   *
   * These are his and they stay his. The board used to sort every
   * value and hand the man in second place the second largest, so the
   * column fell down the page, and it did that by printing numbers
   * belonging to other people: Gibbs is first and worth 159, Bijan is
   * second and worth 239, and the curve gave Gibbs 239 and Bijan 159.
   * Value now falls out of step with the order about half the time,
   * which is the truth of it. The order is four opinions together and
   * his points are one of them, so a man the room rates above his
   * projection shows exactly that.
   */
  for (const p of men) {
    const plays = p.games!;
    p.perGameVor = Number(((p.ppg ?? 0) - (bar[p.position] ?? 0)).toFixed(1));
    p.vor = Number((plays * ((p.ppg ?? 0) - (bar[p.position] ?? 0))).toFixed(1));
  }

  const onTheCurve = men.filter((p) => !OWN_ORDER.has(p.position));
  const modelAt = placesBy(onTheCurve, (p) => p.vor);
  const shareAt = placesBy(onTheCurve, (p) => p.touches);
  const adpAt = placesBy(onTheCurve, (p) => (p.adp == null ? null : -p.adp));
  /**
   * The walk keeps quiet on rookies. It has no plays to draw from for
   * them, and its third of a point a game dragged every one of them to
   * the bottom of the board.
   */
  const walkAt = placesBy(onTheCurve, (p) =>
    p.simulated && !p.rookie
      ? payFor(p.simulated, pays) - (bar[p.position] ?? 0)
      : null);

  /**
   * Kickers and defences are ours to order and the room's to place.
   * Giving a kicker the attempts his side's drives produce beats his
   * draft position .38 to .20, but where the group belongs is another
   * question that value over replacement answers badly, since both are
   * replaced off the waiver wire in a week.
   */
  const placeIn = new Map<string, number>();

  for (const where of OWN_ORDER) {
    const its = men.filter((p) => p.position === where);
    const picks = its
      .map((p) => p.adp)
      .filter((adp): adp is number => Boolean(adp))
      .sort((a, b) => a - b);
    [...its]
      .sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0))
      .forEach((p, i) => {
        placeIn.set(p.key, picks[i] ?? (picks[picks.length - 1] ?? 300) + i);
      });
  }

  const atIndex = new Map(onTheCurve.map((p, i) => [p.key, i]));

  for (const p of men) {
    if (OWN_ORDER.has(p.position)) {
      p.blend = placeIn.get(p.key) ?? 400;
      continue;
    }

    const i = atIndex.get(p.key)!;
    const lean = p.position === "QB" ? QB_LEAN : LEAN;
    const votes: [number, number | undefined][] = [
      [lean.model, modelAt.get(i)],
      [lean.share, shareAt.get(i)],
      [lean.adp, adpAt.get(i)],
      [lean.walk, walkAt.get(i)],
    ];
    const counted = votes.filter(([w, place]) => w > 0 && place !== undefined);
    const weight = counted.reduce((sum, [w]) => sum + w, 0);
    p.blend = weight > 0
      ? counted.reduce((sum, [w, place]) => sum + w * place!, 0) / weight
      : men.length;
  }

  men.sort((a, b) => (a.blend ?? 0) - (b.blend ?? 0));
  men.forEach((p, i) => { p.rank = i + 1; });

  /**
   * Where the room takes him, as a place rather than an average.
   * Writing an average as a round and a pick left 1.02 empty and put
   * two men on 1.05, since nobody averages between 1.5 and 2.4.
   */
  [...men]
    .filter((p) => p.adp)
    .sort((a, b) => a.adp! - b.adp!)
    .forEach((p, i) => { p.adpRank = i + 1; });


  /**
   * The spreads were worked out under whatever the build scored, so
   * they move with him rather than being recomputed.
   *
   * Measured against the file's own middle, not against what he scores
   * here. Scaling from the scored number instead left the card showing
   * 19.8 a game beside a value worked out from 20.1.
   */
  for (const p of men) {
    const built = p.game?.["ev"] ?? 0;

    // nothing to scale from, so there is no spread to show rather than
    // one that disagrees with the number beside it
    if (built <= 0) {
      p.game = null;
      p.sim = p.sim ? { ev: 0, q1: 0, mid: 0, q3: 0, low: 0, high: 0, games: p.sim.games } : null;
      continue;
    }

    const moved = (p.ppg ?? 0) / built;
    p.game = scaled(p.game!, moved, 1);

    if (p.sim) {
      p.sim = { ...scaled(p.sim, moved, 0), games: p.sim.games };
    }
  }

  return men;
}

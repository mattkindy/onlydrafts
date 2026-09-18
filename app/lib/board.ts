/**
 * The board in one league's terms.
 *
 * The file ships what each player does in a game and where rooms draft
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
import type { Roster } from "./providers.ts";
import { replacementBar } from "./replacementPool.ts";
import { defenceWeeks, spreadOf } from "./spread.ts";
import { notePassCatchers } from "./winShare.ts";

export interface League {
  teams: number;
  slots?: string[] | null;
  pays: Pays;
  /**
   * Every team's players, when the league has told us. What a kicker or
   * a defence is worth turns on how many of them the room keeps, and
   * that is a fact about these twelve people rather than about leagues
   * in general.
   */
  rosters?: Roster[] | null;
}

/** the same weights the board is built with, quarterbacks apart */
const LEAN = { model: 0.1, share: 0.3, adp: 0.4, sim: 0.2 };
const QB_LEAN = { model: 0.03, share: 0, adp: 0.12, sim: 0.85 };

/** ordered among themselves, placed where the room drafts them */
const OWN_ORDER = new Set(["K", "DEF"]);

const WHERE = ["QB", "RB", "WR", "TE", "K", "DEF"];

/**
 * Which mock drafts to read. A point a catch moves receivers up, so a
 * ppr league reading standard mocks is reading the wrong room.
 */
export function roomFor(pays: Pays | null | undefined): "ppr" | "half" | "standard" {
  const perCatch = pays?.["rec"] ?? 0;

  return perCatch >= 0.75 ? "ppr" : perCatch >= 0.25 ? "half" : "standard";
}

function placesBy<T>(players: T[], by: (p: T) => number | null | undefined) {
  const at = new Map<number, number>();

  players
    .map((p, i) => ({ i, v: by(p) }))
    .filter((r): r is { i: number; v: number } => r.v !== null && r.v !== undefined)
    .sort((a, b) => b.v - a.v)
    .forEach((r, k) => at.set(r.i, k + 1));

  return at;
}

/**
 * What the last player the league would start at each position scores.
 * A league starting two quarterbacks has a better one left over, so
 * the gap to him is smaller and every quarterback is worth less.
 */
function lastStarter(
  players: Player[],
  started: Record<string, number>,
  of: (p: Player) => number | null | undefined,
) {
  const bar: Record<string, number> = {};

  for (const where of WHERE) {
    const ranked = players
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

/**
 * How many times his middle week a player's high week can run before we
 * stop believing the spread. Everyone the projection is sure of comes in
 * between two and four, and nine is the widest on the whole board.
 */
const WIDEST_WEEK = 10;

/**
 * A spread too wide to believe. Asked in multiples so the answer is the
 * same whatever the build scored: half a point a catch gives a fringe
 * receiver half the middle week a full point does, and his high week
 * barely moves, so the multiple doubles on a player whose role never changed.
 */
function runsAway(band: Record<string, number>): boolean {
  const middle = band["ev"] ?? 0;

  return middle > 0 && (band["high"] ?? 0) / middle >= WIDEST_WEEK;
}

/** no spread on the card, rather than one that disagrees with him */
function forgetSpread(p: Player): void {
  p.game = null;
  p.sim = p.sim
    ? { ev: 0, q1: 0, mid: 0, q3: 0, low: 0, high: 0, games: p.sim.games }
    : null;
}

/**
 * A season's fixtures as the board ships them: eighteen entries a team,
 * the opponent each week and nothing in the bye week.
 */
export type Schedule = Record<string, (string | null)[]>;

/**
 * His spread moved into this league's terms.
 *
 * The spreads were worked out under whatever the build scored, so they
 * move with him rather than being recomputed, and against the file's own
 * middle. Scaling from the scored number left the card showing 19.8 a
 * game beside a value worked out from 20.1.
 *
 * Where the middle week is half a point or less, or the spread already
 * runs away, he gets no spread at all rather than one that disagrees
 * with the number beside it.
 */
function rescaleSpread(p: Player, pays: Pays): void {
  // a defence ships the rates behind a spread rather than a spread, so
  // its weeks are drawn here
  const drawn = p.position === "DEF" && p.simulated
    ? spreadOf(defenceWeeks(p.simulated, pays, p.key))
    : null;

  if (drawn) {
    if (drawn.ev <= 0.5 || runsAway({ ...drawn })) {
      p.game = null;
      p.sim = null;

      return;
    }

    const moved = (p.ppg ?? 0) / drawn.ev;
    p.game = scaled({ ...drawn }, moved, 1);
    p.sim = { ...scaled({ ...drawn }, moved * 17, 0), games: 17 };

    return;
  }

  const built = p.game?.["ev"] ?? 0;

  if (built <= 0.5 || runsAway(p.game!)) {
    forgetSpread(p);

    return;
  }

  const moved = (p.ppg ?? 0) / built;
  p.game = scaled(p.game!, moved, 1);

  if (p.sim) {
    p.sim = { ...scaled(p.sim, moved, 0), games: p.sim.games };
  }
}

/**
 * What he beats the last starter at his position by, over a season.
 *
 * A player who misses four weeks gives you thirteen weeks of the gap and
 * nothing for the other four, so a fragile player and a durable one with
 * the same average are priced apart.
 *
 * This is what his own projection says he is worth, which is one of the
 * four opinions the board blends. What a card shows comes later and is a
 * different thing: what a pick where the board has him is worth.
 */
function priceAgainstReplacement(p: Player, bar: Record<string, number>): void {
  const plays = p.games!;
  const against = (bar[p.position] ?? 0) * plays;
  p.perGameVor = Number(((p.ppg ?? 0) - (bar[p.position] ?? 0)).toFixed(1));
  p.vor = Number((plays * ((p.ppg ?? 0) - (bar[p.position] ?? 0))).toFixed(1));
  // kept aside, because the curve later replaces vor with what a pick at
  // his place is worth and a reader deserves to see both
  p.ownVor = p.vor;

  if (!p.sim?.["ev"]) {
    return;
  }

  /**
   * The same over the middle ninety of his seasons, since two players on
   * the same number are not the same bet. The low end is harsher than it
   * should be, because each quantile is charged the same expected games.
   */
  p.par = {
    low: Number((p.sim["low"]! - against).toFixed(1)),
    mid: Number((p.sim["mid"]! - against).toFixed(1)),
    high: Number((p.sim["high"]! - against).toFixed(1)),
  };
}

/**
 * What a pick here is worth, which is the number a card shows.
 *
 * The board orders by four opinions together and his own projected value
 * is one of them, so the two disagree about half the time. A card showing
 * his projection while the list is ordered by the blend reads as a broken
 * sort. So the values are sorted and read back at each player's place,
 * over a season and over a game both, and what he scores is untouched.
 *
 * A kicker or a defence is read at the place the room puts him, off the
 * same curve. Leaving them out was what let a defence show a bigger
 * number than every skill player around it: twelve teams start twelve
 * defences, so twelve clear the last starter every year whatever happens.
 */
function readValuesOffTheCurve(players: Player[]): void {
  const inOrder = players.filter((p) => !OWN_ORDER.has(p.position));
  const curve = inOrder.map((p) => p.vor ?? 0).sort((a, b) => b - a);
  const readAt = (p: Player, at: number) => {
    p.vor = Number((curve[at] ?? 0).toFixed(1));
    p.perGameVor = Number((p.vor / Math.max(1, p.games ?? 17)).toFixed(1));
  };

  inOrder.forEach(readAt);

  let skillAhead = 0;

  for (const p of players) {
    if (!OWN_ORDER.has(p.position)) {
      skillAhead++;
      continue;
    }

    readAt(p, Math.min(skillAhead, curve.length - 1));
  }
}

export function rescore(
  asShipped: Player[], league: League, schedule?: Schedule | null,
): Player[] {
  const { pays } = league;
  const room = roomFor(pays);
  const started = startedHere(league.slots, league.teams);

  const players = asShipped.map((p): Player => {
    const market = p.adpBy?.[room];
    const ppg = Number(scoredHere(p, pays).toFixed(1));

    return {
      ...p,
      // what the simulation expects him to play, which is what prices a
      // fragile player against a durable one on the same average
      games: p.games ?? p.sim?.games ?? 17,
      ...(market ? { adp: market.adp, adpLow: market.low, adpHigh: market.high } : {}),
      ppg,
      ownPpg: ppg,
      // the regression's own game, kept apart so its slot in the blend
      // stays its own voice now that ppg leads with the simulation
      regressionPpg: p.projected
        ? Number(payFor(p.projected, pays).toFixed(1))
        : ppg,
    };
  });

  for (const p of players) {
    rescaleSpread(p, pays);
  }

  const bar = replacementBar({
    players,
    teams: league.teams,
    rosters: league.rosters ?? null,
    lastStarter: lastStarter(players, started, (p) => p.ppg),
  });

  for (const p of players) {
    priceAgainstReplacement(p, bar);
  }

  const onTheCurve = players.filter((p) => !OWN_ORDER.has(p.position));
  const regressionBar = lastStarter(players, started, (p) => p.regressionPpg);
  const modelAt = placesBy(onTheCurve, (p) =>
    (p.games ?? 17) *
      ((p.regressionPpg ?? 0) - (regressionBar[p.position] ?? 0)));
  const shareAt = placesBy(onTheCurve, (p) => p.touches);
  const adpAt = placesBy(onTheCurve, (p) => (p.adp == null ? null : -p.adp));
  // the simulation speaks about rookies too, drawing them from the pools
  // at the share their draft slot buys
  const simAt = placesBy(onTheCurve, (p) =>
    p.walked
      ? payFor(p.walked, pays) - (bar[p.position] ?? 0)
      : null);

  // kickers and defences are ours to order and the room's to place,
  // since value over replacement answers the second question badly
  const placeIn = new Map<string, number>();

  for (const where of OWN_ORDER) {
    const its = players.filter((p) => p.position === where);
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

  for (const p of players) {
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
      [lean.sim, simAt.get(i)],
    ];
    const counted = votes.filter(([w, place]) => w > 0 && place !== undefined);
    const weight = counted.reduce((sum, [w]) => sum + w, 0);
    p.blend = weight > 0
      ? counted.reduce((sum, [w, place]) => sum + w * place!, 0) / weight
      : players.length;
  }

  players.sort((a, b) => (a.blend ?? 0) - (b.blend ?? 0));
  players.forEach((p, i) => { p.rank = i + 1; });

  readValuesOffTheCurve(players);

  // where the room takes him, as a place rather than an average: writing
  // an average as a round and a pick left 1.02 empty and two players on 1.05
  [...players]
    .filter((p) => p.adp)
    .sort((a, b) => a.adp! - b.adp!)
    .forEach((p, i) => { p.adpRank = i + 1; });

  // who each team's first pass catcher is and who it plays are the
  // board's to say rather than one player's
  notePassCatchers(
    players,
    schedule
      ? (team, week) => schedule[team]?.[week - 1] ?? null
      : null,
  );

  return players;
}

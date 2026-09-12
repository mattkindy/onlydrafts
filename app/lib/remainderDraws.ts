/**
 * Which live games the remainder engine answers for, and what it says.
 *
 * From half time on, playing the rest of a game out beats pulling a
 * man's week line toward what he has done, so a game that has reached
 * the third quarter is handed to the engine and everything earlier
 * stays on the copula posterior.
 */

import { leagueOf, remainderFor, type RemainderState } from "./remainder.ts";
import type { SimTables } from "./simTables.ts";
import type { LiveSituation } from "./matchups.ts";
import type { Pays } from "./scoring.ts";

/** how many replays a live game gets */
export const REMAINDER_DRAWS = 2000;

/** the halves are 1800 seconds, so this is the second half and later */
export const pastHalfTime = (situation: LiveSituation) =>
  situation.secondHalf && situation.secondsLeft > 0;

const seedOf = (situation: LiveSituation) => {
  let seed = 2166136261;

  for (const letter of `${situation.home}|${situation.away}`) {
    seed = Math.imul(seed ^ letter.charCodeAt(0), 16777619);
  }

  return (seed ^ (situation.secondsLeft * 31)) >>> 0;
};

export const stateOf = (situation: LiveSituation): RemainderState => ({
  home: situation.home,
  away: situation.away,
  points: situation.points,
  secondsLeft: situation.secondsLeft,
  withBall: situation.withBall,
  yardline: situation.yardline,
  down: situation.down,
  toGo: situation.toGo,
  timeouts: situation.timeouts,
  warningLeft: situation.warningLeft,
  secondHalf: situation.secondHalf,
});

/** every game past half time, once each, in the order they are keyed */
export function gamesToPlay(
  situations: Map<string, LiveSituation>,
): { state: RemainderState; seed: number }[] {
  const seen = new Set<string>();
  const out: { state: RemainderState; seed: number }[] = [];

  for (const situation of situations.values()) {
    const name = `${situation.home}|${situation.away}`;

    if (seen.has(name) || !pastHalfTime(situation)) {
      continue;
    }

    seen.add(name);
    out.push({ state: stateOf(situation), seed: seedOf(situation) });
  }

  return out;
}

/** what each man in those games still has to come, draw by draw */
export function remainderDraws(
  tables: SimTables, situations: Map<string, LiveSituation>, pays: Pays,
  draws = REMAINDER_DRAWS,
): Map<string, number[]> {
  const league = leagueOf(tables);
  const out = new Map<string, number[]>();

  for (const game of gamesToPlay(situations)) {
    const played = remainderFor(
      tables, league, game.state, draws, pays, game.seed);

    if (!played) {
      continue;
    }

    for (const [key, its] of played.men) {
      out.set(key, Array.from(its));
    }
  }

  return out;
}

/** the tables for a season, fetched once and kept */
const loaded = new Map<number, Promise<SimTables | null>>();

export function simTablesFor(season: number): Promise<SimTables | null> {
  const already = loaded.get(season);

  if (already) {
    return already;
  }

  const asked = fetch(`data/sim-${season}.json`)
    .then((answered) => answered.ok
      ? (answered.json() as Promise<SimTables>)
      : null)
    .catch(() => null);
  loaded.set(season, asked);

  return asked;
}

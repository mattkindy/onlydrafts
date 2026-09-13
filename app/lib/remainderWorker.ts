/**
 * The remainder engine, off the main thread.
 *
 * Two thousand replays of a game take long enough to drop frames, and
 * a live page runs one per game in progress, so the work happens here
 * and the page gets back one array of points a player.
 */

import { leagueOf, remainderFor, type RemainderState } from "./remainder.ts";
import type { SimTables } from "./simTables.ts";
import type { Pays } from "./scoring.ts";

export interface RemainderAsk {
  tables: SimTables;
  games: { state: RemainderState; seed: number }[];
  draws: number;
  pays: Pays;
}

export interface RemainderAnswer {
  /** by the slate's key for a player, one number a draw */
  players: Record<string, number[]>;
  /** and how long the whole ask took, so a page can say */
  millis: number;
}

export function answer(ask: RemainderAsk): RemainderAnswer {
  const started = Date.now();
  const league = leagueOf(ask.tables);
  const players: Record<string, number[]> = {};

  for (const game of ask.games) {
    const played = remainderFor(
      ask.tables, league, game.state, ask.draws, ask.pays, game.seed);

    if (!played) {
      continue;
    }

    for (const [key, its] of played.players) {
      players[key] = Array.from(its);
    }
  }

  return { players, millis: Date.now() - started };
}

self.onmessage = (event: MessageEvent<RemainderAsk>) => {
  self.postMessage(answer(event.data));
};

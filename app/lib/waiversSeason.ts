/**
 * The waiver page's season pricing, gathered into one ask and one
 * answer so it can happen off the main thread.
 *
 * Drawing a year of weeks for the whole board takes a few hundred
 * milliseconds on a phone, and nothing paints while it does. A worker
 * takes the rescored board and the league and sends back the priced
 * rows, so the page can put up a spinner and fill in.
 *
 * The ask comes in two parts because the second one depends on what the
 * reader has filtered to. The board is drawn once for the season ask
 * and the worker keeps it, so asking what a handful of adds cost is
 * quick however often the filter changes.
 */

import { listingFits, playsByWeek, type Listed } from "./availability.ts";
import type { Room } from "./draftShare.ts";
import { roomFor } from "./draftShare.ts";
import type { Roster } from "./providers.ts";
import type { Player } from "./scoring.ts";
import {
  addsFor, dropsFor, netsFor, type Add, type Drop, type Net,
} from "./waivers.ts";

/** who each side plays each week, as the board ships it */
export type Schedule = Record<string, (string | null)[]>;

export interface SeasonAsk {
  ask: "season";
  /** the board in this league's terms */
  players: Player[];
  /**
   * The drawn weeks need to know who each side plays, and the board is
   * the only thing that says. Without it the players in a game stop moving
   * together and a side's week comes out far too narrow.
   */
  schedule: Schedule | null;
  slots: string[] | null;
  teams: number;
  draws: number;
  rosters: Roster[] | null;
  /** your roster and the wire by key, since the board has the rest */
  mine: string[];
  pool: string[];
  /**
   * The coming week. Only it and the weeks after it are drawn, since the
   * weeks already played are over for a player picked up now. Without it
   * the whole season is drawn, the way the draft board draws it.
   */
  from?: number;
  /** what the injury report says of each player listed, by his key */
  hurt?: Record<string, string>;
}

/**
 * What the injury report says of each player on the board, by his key.
 * A listing whose position is not his is somebody else with his name.
 */
export function statusesOn(
  players: Player[], listed: Map<string, Listed>,
): Record<string, string> {
  const said: Record<string, string> = {};

  for (const p of players) {
    const his = listed.get(p.key);

    if (his?.status && listingFits(his, p.position)) {
      said[p.key] = his.status;
    }
  }

  return said;
}

/**
 * The board priced for the weeks left: each player drawn from the coming
 * week on, with his games there cut by what the injury report says. A man
 * on reserve scores nothing for the weeks the list costs him.
 */
export function forTheWeeksLeft(
  players: Player[], from: number, hurt: Record<string, string> = {},
): Player[] {
  return players.map((p) => ({
    ...p,
    weeksLeft: { from, plays: playsByWeek(p.games, hurt[p.key], from, p.bye) },
  }));
}

export interface NetsAsk {
  ask: "nets";
  /** the adds that get a drop worked out, by key */
  keys: string[];
  openSpots: number | null;
}

export type WaiversAsk = SeasonAsk | NetsAsk;

export interface SeasonAnswer {
  said: "season";
  adds: Add[];
  drops: Drop[];
}

export interface NetsAnswer {
  said: "nets";
  /** by the add's key, since a Map does not survive the trip on its own */
  nets: [string, Net][];
}

export type WaiversAnswer = SeasonAnswer | NetsAnswer;

/** what a season ask leaves behind, so a nets ask draws nothing again */
export interface Kept {
  mine: Player[];
  slots: string[] | null;
  room: Room;
  adds: Add[];
}

export function priceSeason(
  ask: SeasonAsk,
): { answer: SeasonAnswer; kept: Kept } {
  const players = ask.from === undefined
    ? ask.players
    : forTheWeeksLeft(ask.players, ask.from, ask.hurt);
  const byKey = new Map(players.map((p) => [p.key, p]));
  const ours = (keys: string[]) => keys
    .map((key) => byKey.get(key))
    .filter((p): p is Player => Boolean(p));
  const mine = ours(ask.mine);
  const room = roomFor(
    players, ask.slots, ask.teams, ask.draws, ask.rosters);
  const adds = addsFor(mine, ours(ask.pool), ask.slots, room);

  return {
    answer: {
      said: "season", adds, drops: dropsFor(mine, ask.slots, room),
    },
    kept: { mine, slots: ask.slots, room, adds },
  };
}

export function priceNets(kept: Kept, ask: NetsAsk): NetsAnswer {
  const byKey = new Map(kept.adds.map((row) => [row.p.key, row]));
  const asked = ask.keys
    .map((key) => byKey.get(key))
    .filter((row): row is Add => Boolean(row));

  return {
    said: "nets",
    nets: [...netsFor(
      kept.mine, asked, kept.slots, kept.room, ask.openSpots)],
  };
}

/** where a page sends its asks, whether that is a worker or this thread */
export interface Pricer {
  season(ask: SeasonAsk): Promise<SeasonAnswer>;
  nets(ask: NetsAsk): Promise<NetsAnswer>;
  close(): void;
}

const NO_NETS: NetsAnswer = { said: "nets", nets: [] };

/**
 * A pricer that works on whatever thread it is called from, for a
 * browser with no workers and for the tests.
 */
export function pricerHere(): Pricer {
  let kept: Kept | null = null;

  return {
    season: async (ask) => {
      const said = priceSeason(ask);
      kept = said.kept;

      return said.answer;
    },
    nets: async (ask) => kept ? priceNets(kept, ask) : NO_NETS,
    close: () => {},
  };
}

/**
 * The same off the main thread, kept alive between asks so the board is
 * drawn once.
 *
 * Every ask is answered exactly once and in order, so the promises wait
 * in a line. A worker that falls over settles the whole line with
 * nothing rather than leaving the page spinning.
 */
export function pricerInWorker(): Pricer {
  if (typeof Worker === "undefined") {
    return pricerHere();
  }

  const worker = new Worker(
    new URL("./waiversWorker.ts", import.meta.url), { type: "module" });
  const line: ((said: WaiversAnswer | null) => void)[] = [];

  worker.onmessage = (event: MessageEvent<WaiversAnswer>) => {
    line.shift()?.(event.data);
  };

  worker.onerror = () => {
    while (line.length) {
      line.shift()?.(null);
    }
  };

  const send = (ask: WaiversAsk) =>
    new Promise<WaiversAnswer | null>((settle) => {
      line.push(settle);
      worker.postMessage(ask);
    });

  return {
    season: async (ask) => {
      const said = await send(ask);

      return said?.said === "season"
        ? said
        : { said: "season", adds: [], drops: [] };
    },
    nets: async (ask) => {
      const said = await send(ask);

      return said?.said === "nets" ? said : NO_NETS;
    },
    close: () => worker.terminate(),
  };
}

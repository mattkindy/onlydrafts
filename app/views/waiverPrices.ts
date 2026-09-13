/**
 * The waiver page's season figures, worked out in a worker.
 *
 * A page that priced them itself froze for a second or two before it
 * drew anything, so the pricing is a hook: the rows arrive when they
 * arrive and the page says it is working until they do.
 *
 * There are two rounds. The first prices the whole wire and your whole
 * roster. The second asks what a spot for the few adds at the top of
 * the list would cost, which cannot be asked until the reader's filter
 * has said which ones those are.
 */

import { useEffect, useMemo, useState } from "preact/hooks";

import type { League } from "../lib/providers.ts";
import { rostersOf } from "../lib/replacementPool.ts";
import type { Player } from "../lib/scoring.ts";
import { openSpotsFor, type Add, type Drop, type Net } from "../lib/waivers.ts";
import {
  pricerInWorker, type Pricer, type Schedule,
} from "../lib/waiversSeason.ts";
import { matchesFilter } from "./Draft.tsx";

/**
 * Fewer draws than the draft board takes, because the wire is the whole
 * board and every add is one subtraction a week against one baseline.
 */
export const WEEKS_DRAWN = 2000;

/**
 * How many adds get a drop worked out. Pricing one is a season for every
 * player on the roster, so the top of the list is as far as this goes.
 */
export const PRICED = 12;

/** how far down the wire the page goes before it stops listing anybody */
export const LISTED = 60;

interface Said {
  adds: Add[];
  drops: Drop[];
  openSpots: number | null;
}

export interface WaiverPrices {
  /** the wire the page shows: the filter and the cap applied */
  listed: Add[];
  drops: Drop[];
  /** the top of the list with the player a spot for him would cost */
  priced: { row: Add; paid: Net }[];
  /** the first round has not landed, so there is nothing to draw yet */
  working: boolean;
}

export function useWaiverPrices(
  players: Player[], league: League, schedule: Schedule | null, posFilter: string,
): WaiverPrices {
  const [said, setSaid] = useState<Said | null>(null);
  const [nets, setNets] = useState<Map<string, Net>>(new Map());
  const [pricer, setPricer] = useState<Pricer | null>(null);

  useEffect(() => {
    const rostered = new Set(
      league.allRosters.flatMap((r) => r.keys.map((m) => m.key)));
    const mill = pricerInWorker();
    let stale = false;
    setPricer(mill);
    setSaid(null);
    setNets(new Map());

    mill
      .season({
        ask: "season",
        players,
        schedule,
        slots: league.slots ?? null,
        teams: league.size || 12,
        draws: WEEKS_DRAWN,
        rosters: rostersOf(league),
        mine: league.myRoster.map((m) => m.key),
        pool: players.filter((p) => !rostered.has(p.key)).map((p) => p.key),
      })
      .then((answered) => {
        if (stale) {
          return;
        }

        setSaid({
          adds: answered.adds,
          drops: answered.drops,
          // the roster can have players the board has never heard of, and
          // they take up a spot all the same, so the league's own count
          // is the one to subtract
          openSpots: openSpotsFor(league.slots, league.myRoster.length),
        });
      });

    return () => {
      stale = true;
      mill.close();
    };
  }, [players, league, schedule]);

  const listed = useMemo(
    () => (said?.adds ?? [])
      .filter((row) => matchesFilter(row.p, posFilter))
      .slice(0, LISTED),
    [said, posFilter],
  );
  const top = useMemo(() => listed.slice(0, PRICED), [listed]);
  const wanted = top.map((row) => row.p.key).join("|");

  useEffect(() => {
    if (!pricer || !said || !top.length) {
      return;
    }

    let stale = false;

    pricer
      .nets({
        ask: "nets",
        keys: wanted.split("|"),
        openSpots: said.openSpots,
      })
      .then((answered) => {
        if (!stale) {
          setNets(new Map(answered.nets));
        }
      });

    return () => { stale = true; };
  }, [pricer, said, wanted]);

  const priced = useMemo(
    () => top
      .filter((row) => nets.has(row.p.key))
      .map((row) => ({ row, paid: nets.get(row.p.key)! }))
      .sort((a, b) => b.paid.net - a.paid.net),
    [top, nets],
  );

  return { listed, drops: said?.drops ?? [], priced, working: said === null };
}

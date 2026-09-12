/**
 * Who to add, who that costs you, and what the pair is worth.
 *
 * Adds are everybody no team in the league has, priced by what putting
 * him on your roster does to how often you win a week. Drops are your
 * own men, priced by what taking one off costs. For the handful of adds
 * worth thinking about, the page also says who would go: nobody if
 * there is a spot open, otherwise the cheapest man to drop once the
 * newcomer is already on the roster.
 */

import { useMemo } from "preact/hooks";

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import { roomFor } from "../lib/draftShare.ts";
import {
  addsFor, dropsFor, netFor, openSpotsFor, type Add, type Drop, type Net,
} from "../lib/waivers.ts";
import { matchesFilter } from "./Draft.tsx";

/**
 * Fewer draws than the draft board takes, because the wire is the whole
 * board and every add is one subtraction a week against one baseline.
 */
const WEEKS_DRAWN = 2000;

/**
 * How many adds get a drop worked out. Pricing one is a baseline for
 * every man on the roster, so the top of the list is as far as this can
 * go and stay quick.
 */
const PRICED = 12;

interface Props {
  men: Player[];
  league: League;
  posFilter: string;
  onMore: (p: Player) => void;
}

function signed(share: number, places = 1): string {
  const text = (100 * share).toFixed(places);

  return share > 0 ? `+${text}` : text;
}

function pct(share: number): string {
  return `${(100 * share).toFixed(0)}%`;
}

function AddRow(
  { row, paid, onMore }: { row: Add; paid: Net | null; onMore: () => void },
) {
  return (
    <tr onClick={onMore}>
      <td>{row.p.name}</td>
      <td>{row.p.position}</td>
      <td>{row.p.team ?? ""}</td>
      <td>{(row.p.ppg ?? 0).toFixed(1)}</td>
      <td>{pct(row.starts)}</td>
      <td><b>{signed(row.added)}</b></td>
      <td>{paid ? paid.drop?.name ?? "open spot" : ""}</td>
      <td>{paid ? <b>{signed(paid.net)}</b> : ""}</td>
    </tr>
  );
}

function DropRow({ row, onMore }: { row: Drop; onMore: () => void }) {
  return (
    <tr onClick={onMore}>
      <td>{row.p.name}</td>
      <td>{row.p.position}</td>
      <td>{(row.p.ppg ?? 0).toFixed(1)}</td>
      <td>{pct(row.starts)}</td>
      <td><b>{signed(row.costs)}</b></td>
    </tr>
  );
}

export function Waivers(props: Props) {
  const { men, league, posFilter } = props;

  const { adds, drops, mine, room, openSpots } = useMemo(() => {
    const rostered = new Set(
      league.allRosters.flatMap((r) => r.keys.map((m) => m.key)),
    );
    const mine = league.myRoster
      .map((m) => men.find((p) => p.key === m.key))
      .filter((p): p is Player => Boolean(p));
    const pool = men.filter((p) => !rostered.has(p.key));
    const room = roomFor(men, league.slots, league.size || 12, WEEKS_DRAWN);

    return {
      adds: addsFor(mine, pool, league.slots, room),
      drops: dropsFor(mine, league.slots, room),
      mine,
      room,
      // the roster can have men the board has never heard of, and they
      // take up a spot all the same, so the league's own count is the
      // one to subtract
      openSpots: openSpotsFor(league.slots, league.myRoster.length),
    };
  }, [men, league]);

  const shown = useMemo(
    () => adds.filter((row) => matchesFilter(row.p, posFilter)),
    [adds, posFilter],
  );

  /** the top of the list, each with the man he would cost you */
  const priced = useMemo(
    () => shown
      .slice(0, PRICED)
      .map((row) => ({
        row, paid: netFor(mine, row, league.slots, room, openSpots),
      }))
      .sort((a, b) => b.paid.net - a.paid.net),
    [shown, mine, room, league, openSpots],
  );

  const best = priced[0] ?? null;

  if (!drops.length) {
    return (
      <div class="empty">
        <b>Nobody on your roster yet.</b> Once your league has a team for
        you, this page says what each man on the wire would add.
      </div>
    );
  }

  return (
    <>
      <h2>who to add</h2>
      <table class="line">
        <thead>
          <tr>
            <th>player</th>
            <th>pos</th>
            <th>team</th>
            <th>ppg</th>
            <th>starts</th>
            <th>win chance</th>
            <th>drop</th>
            <th>net</th>
          </tr>
        </thead>
        <tbody>
          {priced.map(({ row, paid }) => (
            <AddRow
              key={row.p.key}
              row={row}
              paid={paid}
              onMore={() => props.onMore(row.p)}
            />
          ))}
          {shown.slice(PRICED, 60).map((row) => (
            <AddRow
              key={row.p.key}
              row={row}
              paid={null}
              onMore={() => props.onMore(row.p)}
            />
          ))}
        </tbody>
      </table>

      <h2>what dropping each of yours costs</h2>
      <table class="line">
        <thead>
          <tr>
            <th>player</th>
            <th>pos</th>
            <th>ppg</th>
            <th>starts</th>
            <th>win chance</th>
          </tr>
        </thead>
        <tbody>
          {drops.map((row) => (
            <DropRow
              key={row.p.key}
              row={row}
              onMore={() => props.onMore(row.p)}
            />
          ))}
        </tbody>
      </table>

      {best && (
        <p class="hint">
          {best.paid.drop
            ? (
              <>
                Adding <b>{best.row.p.name}</b> and dropping{" "}
                <b>{best.paid.drop.name}</b> leaves you{" "}
                <b>{signed(best.paid.net)}</b> points of win chance better off.
              </>
            )
            : (
              <>
                You have a spot open, so <b>{best.row.p.name}</b> can be added
                without dropping anybody, and he is worth{" "}
                <b>{signed(best.paid.net)}</b> points of win chance.
              </>
            )}
        </p>
      )}
    </>
  );
}

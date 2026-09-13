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
import { rostersOf } from "../lib/replacementPool.ts";
import {
  addsFor, dropsFor, netFor, openSpotsFor, WORTH_ADDING,
  type Add, type Drop, type Net,
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

/** how far down the wire the page goes before it stops listing anybody */
const LISTED = 60;

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

/** points a week, which unlike a win chance is not a percentage */
function points(n: number): string {
  const text = n.toFixed(1);

  return n > 0 ? `+${text}` : text;
}

/** how often you win a week either side of the move, both said out loud */
function Swing({ before, after }: { before: number; after: number }) {
  return <span class="swing">{pct(before)} → {pct(after)}</span>;
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
      <td>{points(row.brings)}</td>
      <td>{row.displaced?.name ?? "an empty seat"}</td>
      <td><Swing before={row.before} after={row.after} /></td>
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
      <td>{row.takes.toFixed(1)}</td>
      <td>{row.heir?.name ?? "the wire"}</td>
      <td><Swing before={row.before} after={row.after} /></td>
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
    const room = roomFor(
      men, league.slots, league.size || 12, WEEKS_DRAWN, rostersOf(league),
    );

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

  const listed = useMemo(() => shown.slice(0, LISTED), [shown]);

  /** the top of the list, each with the man he would cost you */
  const priced = useMemo(
    () => listed
      .slice(0, PRICED)
      .map((row) => ({
        row, paid: netFor(mine, row, league.slots, room, openSpots),
      }))
      .sort((a, b) => b.paid.net - a.paid.net),
    [listed, mine, room, league, openSpots],
  );

  /**
   * Only the top of the list has a drop worked out, and paying for a man
   * can only take value off him, so anybody adding less than the bar
   * cannot clear it once he is paid for either.
   */
  const worth = priced.filter(({ paid }) => paid.net >= WORTH_ADDING);
  const rest = listed.slice(PRICED).filter((row) => row.added >= WORTH_ADDING);
  const hidden = listed.length - worth.length - rest.length;
  const best = worth[0] ?? null;

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
            <th>pts a week</th>
            <th>instead of</th>
            <th>week won</th>
            <th>win chance</th>
            <th>drop</th>
            <th>net</th>
          </tr>
        </thead>
        <tbody>
          {worth.map(({ row, paid }) => (
            <AddRow
              key={row.p.key}
              row={row}
              paid={paid}
              onMore={() => props.onMore(row.p)}
            />
          ))}
          {rest.map((row) => (
            <AddRow
              key={row.p.key}
              row={row}
              paid={null}
              onMore={() => props.onMore(row.p)}
            />
          ))}
        </tbody>
      </table>

      {hidden > 0 && (
        <p class="hint">
          {hidden} more came out under half a point of win chance a week,
          which is inside the noise of the draw, so they are left off.
        </p>
      )}

      <h2>what dropping each of yours costs</h2>
      <table class="line">
        <thead>
          <tr>
            <th>player</th>
            <th>pos</th>
            <th>ppg</th>
            <th>starts</th>
            <th>pts a week</th>
            <th>seat goes to</th>
            <th>week won</th>
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
                <b>{best.paid.drop.name}</b> takes the weeks you win from{" "}
                <b>{pct(best.paid.before)}</b> to <b>{pct(best.paid.after)}</b>,
                so <b>{signed(best.paid.net)}</b> points of win chance a week.
              </>
            )
            : (
              <>
                You have a spot open, so <b>{best.row.p.name}</b> can be added
                without dropping anybody. He takes the weeks you win from{" "}
                <b>{pct(best.paid.before)}</b> to <b>{pct(best.paid.after)}</b>,
                so <b>{signed(best.paid.net)}</b> points of win chance a week.
              </>
            )}
        </p>
      )}
    </>
  );
}

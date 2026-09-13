/**
 * Who to add, who that costs you, and what the pair is worth.
 *
 * Adds are everybody no team in the league has, priced by what putting him
 * on your roster does to how often you win a week. Drops are your own men,
 * priced by what taking one off costs. For the handful of adds worth
 * thinking about, the page also says who would go: nobody if there is a
 * spot open, otherwise the cheapest man to drop with the newcomer there.
 *
 * The same rows read two ways. Rest of season draws a year of weeks against
 * a typical opponent; this week uses the week's own projections, the lineup
 * you would set, and the team you play. A bench man costs nothing this week
 * and something over a season, and only the pair of them says so.
 */

import { useMemo, useState } from "preact/hooks";

import type { Player } from "../lib/scoring.ts";
import type { League, Matchup } from "../lib/providers.ts";
import { roomFor } from "../lib/draftShare.ts";
import { myGameIn, type Lines } from "../lib/matchups.ts";
import { rostersOf } from "../lib/replacementPool.ts";
import type { SlateRow } from "../lib/slate.ts";
import {
  addsFor, dropsFor, netsFor, openSpotsFor, RARELY_STARTS, WORTH_ADDING,
  type Add, type Drop, type Net,
} from "../lib/waivers.ts";
import {
  weekPricesFor, type WeekAdd, type WeekDrop, type WeekPrices,
} from "../lib/waiversWeek.ts";
import { nameOf } from "./Advice.tsx";
import { matchesFilter } from "./Draft.tsx";
import { useScoreboard } from "./scoreboard.ts";

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

/** which of the two questions the reader is asking */
type Span = "week" | "season";

interface Props {
  men: Player[];
  league: League;
  posFilter: string;
  /** the week's projections, by the key a lineup uses for a man */
  rows: Map<string, SlateRow>;
  /** this week's games in your league, for the one you are in */
  games: Matchup[];
  season: number | null;
  week: number | null;
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

/** a seat by the name a reader would use for it */
const seatName = (slot: string) => slot === "FLEX" ? "flex" : slot;

/** how often you win a week either side of the move, both said out loud */
function Swing({ before, after }: { before: number; after: number }) {
  return <span class="swing">{pct(before)} → {pct(after)}</span>;
}

/** the four figures a row shows, whichever question is being asked */
interface Figures {
  /** points the move is worth, a week over the season or in this one */
  points: number;
  /** the seat that changes hands, and who it changes hands with */
  seat: string;
  before: number;
  after: number;
  delta: number;
}

/**
 * The seat a drop hands over, across the drawn season. A man in the lineup
 * once in three weeks is a bench man, and naming the seat he takes in the
 * odd week he starts says less than saying he hardly starts.
 */
function seasonSeat(row: Drop): string {
  if (row.starts < RARELY_STARTS) {
    return "rarely starts";
  }

  const seat = row.seat ? seatName(row.seat) : "the lineup";

  return `${row.heir?.name ?? "the wire"} at ${seat}`;
}

const seasonDrop = (row: Drop): Figures => ({
  points: -row.takes,
  seat: seasonSeat(row),
  before: row.before,
  after: row.after,
  delta: -row.costs,
});

const weekDrop = (
  his: WeekDrop, nameFor: (key: string) => string,
): Figures => ({
  points: -his.takes,
  seat: his.slot
    ? `${his.heir ? nameFor(his.heir) : "nobody"} at ${seatName(his.slot)}`
    : "not starting",
  before: his.before,
  after: his.after,
  delta: -his.costs,
});

const seasonAdd = (row: Add): Figures => ({
  points: row.brings,
  seat: row.displaced?.name ?? "an empty seat",
  before: row.before,
  after: row.after,
  delta: row.added,
});

const weekAdd = (his: WeekAdd, nameFor: (key: string) => string): Figures => ({
  points: his.brings,
  seat: his.displaced
    ? `${nameFor(his.displaced)} at ${seatName(his.slot ?? "")}`
    : his.slot ? "an empty seat" : "would not start",
  before: his.before,
  after: his.after,
  delta: his.added,
});

/** how often he is in the lineup over a season, and where he is this week */
function Starting(
  { starts, at }: { starts: number; at: { slot: string | null } | null },
) {
  return (
    <span class="starting">
      {pct(starts)}
      {at && <i>{at.slot ? "in at " + seatName(at.slot) : "benched"}</i>}
    </span>
  );
}

/** the figures, or a word saying why there are none to show */
function Figured(
  { figures, absent }: { figures: Figures | null; absent: string },
) {
  if (!figures) {
    return (
      <>
        <td>{absent}</td>
        <td></td>
        <td></td>
        <td></td>
      </>
    );
  }

  return (
    <>
      <td>{points(figures.points)}</td>
      <td>{figures.seat}</td>
      <td><Swing before={figures.before} after={figures.after} /></td>
      <td><b>{signed(figures.delta)}</b></td>
    </>
  );
}

function AddRow(
  { row, at, figures, absent, paid, onMore }: {
    row: Add;
    /** where he is in this week's lineup, when the week is loaded */
    at: { slot: string | null } | null;
    figures: Figures | null;
    absent: string;
    /** the man a spot for him costs and what the pair is worth, when priced */
    paid: { drop: string; net: number } | null;
    onMore: () => void;
  },
) {
  return (
    <tr onClick={onMore}>
      <td>{row.p.name}</td>
      <td>{row.p.position}</td>
      <td>{row.p.team ?? ""}</td>
      <td>{(row.p.ppg ?? 0).toFixed(1)}</td>
      <td><Starting starts={row.starts} at={at} /></td>
      <Figured figures={figures} absent={absent} />
      <td>{paid ? paid.drop : ""}</td>
      <td>{paid ? <b>{signed(paid.net)}</b> : ""}</td>
    </tr>
  );
}

function DropRow(
  { row, at, figures, absent, onMore }: {
    row: Drop;
    at: { slot: string | null } | null;
    figures: Figures | null;
    absent: string;
    onMore: () => void;
  },
) {
  return (
    <tr onClick={onMore}>
      <td>{row.p.name}</td>
      <td>{row.p.position}</td>
      <td>{(row.p.ppg ?? 0).toFixed(1)}</td>
      <td><Starting starts={row.starts} at={at} /></td>
      <Figured figures={figures} absent={absent} />
    </tr>
  );
}

/** why this week has nothing to say yet, in the words a reader needs */
function missingWeek(
  week: number | null, rows: Map<string, SlateRow>,
  states: unknown, ours: unknown,
): string | null {
  if (week === null) {
    return "No week has been built yet, so only the season figures are here.";
  }

  if (!rows.size) {
    return "This week's projections have not loaded yet.";
  }

  if (!states) {
    return "Reading the scoreboard...";
  }

  if (!ours) {
    return "You have no game in your league this week, so there is nobody " +
      "to set a lineup against.";
  }

  return null;
}

export function Waivers(props: Props) {
  const { men, league, posFilter, rows, games } = props;
  // before any week has been built there is nothing for the week to say,
  // so the page opens on the season instead of on a table of blanks
  const [span, setSpan] = useState<Span>(
    () => props.week === null ? "season" : "week");
  const { states, trouble } = useScoreboard(
    props.season ?? undefined, props.week ?? undefined);

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
    () => {
      const top = listed.slice(0, PRICED);
      const nets = netsFor(mine, top, league.slots, room, openSpots);

      return top
        .map((row) => ({ row, paid: nets.get(row.p.key)! }))
        .sort((a, b) => b.paid.net - a.paid.net);
    },
    [listed, mine, room, league, openSpots],
  );

  const lines: Lines = useMemo(
    () => new Map(men.map((p) => [p.key, p])), [men]);
  const ours = useMemo(() => myGameIn(games, league.team), [games, league]);
  const nameFor = (key: string) => nameOf(key, rows, lines);

  /**
   * This week's own answer, for the whole roster and for the adds that have
   * a drop worked out. The men further down the list are priced over the
   * season only, since the week has to name the seat each one would take.
   */
  const week: WeekPrices | null = useMemo(() => {
    if (!ours || !states || !rows.size) {
      return null;
    }

    return weekPricesFor(
      {
        side: ours.side,
        against: ours.against,
        slots: league.slots ?? null,
        rows,
        states,
        lines,
      },
      priced.map(({ row, paid }) => ({ p: row.p, drop: paid.drop })),
    );
  }, [ours, states, rows, lines, league, priced]);

  /**
   * Only the top of the list has a drop worked out, and paying for a man
   * can only take value off him, so anybody adding less than the bar
   * cannot clear it once he is paid for either.
   */
  const worth = priced.filter(({ paid }) => paid.net >= WORTH_ADDING);
  const rest = listed.slice(PRICED).filter((row) => row.added >= WORTH_ADDING);
  const hidden = listed.length - worth.length - rest.length;
  const best = worth[0] ?? null;
  const missing = missingWeek(props.week, rows, states, ours);

  /**
   * A row with no week figures says which of the two reasons it is: the
   * week itself has not loaded, or it has and nobody has a line on him.
   */
  const absent = week ? "no line" : "no week";

  /** what an add's row shows, in whichever span is on screen */
  const addSeen = (row: Add, paid: Net | null) => {
    const his = week?.adds.get(row.p.key) ?? null;
    const net = week?.nets.get(row.p.key);

    if (span === "season") {
      return {
        at: his,
        absent,
        figures: seasonAdd(row),
        paid: paid
          ? { drop: paid.drop?.name ?? "open spot", net: paid.net }
          : null,
      };
    }

    return {
      at: his,
      absent,
      figures: his ? weekAdd(his, nameFor) : null,
      paid: net
        ? { drop: net.drop ? nameFor(net.drop) : "open spot", net: net.net }
        : null,
    };
  };

  const dropSeen = (row: Drop) => {
    const his = week?.drops.get(row.p.key) ?? null;

    if (span === "season") {
      return { at: his, absent, figures: seasonDrop(row) };
    }

    return { at: his, absent, figures: his ? weekDrop(his, nameFor) : null };
  };

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
      <div class="controls">
        <span id="posfilter">
          <button
            class={span === "week" ? "on" : ""}
            onClick={() => setSpan("week")}
          >
            this week
          </button>
          <button
            class={span === "season" ? "on" : ""}
            onClick={() => setSpan("season")}
          >
            rest of season
          </button>
        </span>
        <span class="says">
          {span === "season"
            ? "a season of drawn weeks against a typical opponent"
            : week
              ? "the lineup you would set against " + week.opponent +
                ", and how often you beat him"
              : "this week's own game, once the week has loaded"}
        </span>
      </div>

      {span === "week" && missing && <p class="hint">{missing}</p>}
      {span === "week" && trouble && <p class="hint">{trouble}</p>}

      <h2>who to add</h2>
      <table class="line">
        <thead>
          <tr>
            <th>player</th>
            <th>pos</th>
            <th>team</th>
            <th>ppg</th>
            <th>starts</th>
            <th>{span === "week" ? "pts" : "pts a week"}</th>
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
              {...addSeen(row, paid)}
              onMore={() => props.onMore(row.p)}
            />
          ))}
          {rest.map((row) => (
            <AddRow
              key={row.p.key}
              row={row}
              {...addSeen(row, null)}
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
            <th>{span === "week" ? "pts" : "pts a week"}</th>
            <th>{span === "week" ? "takes his seat" : "when he starts"}</th>
            <th>week won</th>
            <th>win chance</th>
          </tr>
        </thead>
        <tbody>
          {drops.map((row) => (
            <DropRow
              key={row.p.key}
              row={row}
              {...dropSeen(row)}
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

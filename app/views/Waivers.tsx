/**
 * Who to add, who that costs you, and what the pair is worth.
 *
 * Adds are everybody no team in the league has, priced by what putting him
 * on your roster does to how often you win a week. Drops are your own players,
 * priced by what taking one off costs. For the handful of adds worth
 * thinking about, the page also says who would go: nobody if there is a
 * spot open, otherwise the cheapest player to drop with the newcomer there.
 *
 * The same rows read two ways. Rest of season draws a year of weeks against
 * a typical opponent; this week uses the week's own projections, the lineup
 * you would set, and the team you play. A bench player costs nothing this week
 * and something over a season, and only the pair of them says so.
 */

import { useMemo, useState } from "preact/hooks";

import { normalizeName } from "../lib/store.ts";
import type { Player } from "../lib/scoring.ts";
import type { League, Matchup } from "../lib/providers.ts";
import { myGameIn, type Lines } from "../lib/matchups.ts";
import type { Slate, SlateRow } from "../lib/slate.ts";
import type { Listed } from "../lib/availability.ts";
import {
  RARELY_STARTS, WORTH_ADDING, type Add, type Drop, type Net,
} from "../lib/waivers.ts";
import type { Schedule } from "../lib/waiversSeason.ts";
import {
  weekPricesFor, type WeekAdd, type WeekDrop, type WeekPrices,
} from "../lib/waiversWeek.ts";
import { nameOf } from "./Advice.tsx";
import { Reading } from "./Reading.tsx";
import { PRICED, useWaiverPrices } from "./waiverPrices.ts";
import { useScoreboard } from "./scoreboard.ts";
import { WeekRanks } from "./WeekRanks.tsx";

/** which of the three questions the reader is asking */
type Span = "week" | "season" | "ranks";

/** what each of them is called, and the line under the controls */
const SPANS: [Span, string][] = [
  ["week", "this week"],
  ["season", "rest of season"],
  ["ranks", "rankings"],
];

interface Props {
  players: Player[];
  league: League;
  posFilter: string;
  /** where the page keeps the filter, when it wants the buttons drawn here */
  onPosFilter?: (where: string) => void;
  /** the week's projections, by the key a lineup uses for a player */
  rows: Map<string, SlateRow>;
  /** this week's games in your league, for the one you are in */
  games: Matchup[];
  /** who each side plays each week, which the drawn weeks need */
  schedule: Schedule | null;
  season: number | null;
  week: number | null;
  /** the week as it was built, which the rankings table lists off */
  slate: Slate | null;
  /** the players on your team, so the rankings can mark them */
  roster: Set<string> | null;
  /** who the injury report has listed, for the rankings table's badges */
  listed: Map<string, Listed>;
  /** why the games could not be read, when they could not */
  gamesStatus?: string;
  onMore: (p: Player) => void;
}

function signed(share: number, places = 0): string {
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

/** what the drop column says when there is a roster spot going spare */
const OPEN_SPOT = "nobody, spot open";

/** a lineup slot by the name a reader would use for it */
const slotName = (slot: string) => slot === "FLEX" ? "FLEX" : slot;

/**
 * How often you win a week either side of the move, and the gap between
 * them. The gap on its own does not say whether you are winning to start
 * with, and the pair on its own leaves the reader subtracting, so they
 * are one reading rather than two columns.
 */
function Swing(
  { before, after, by }: { before: number; after: number; by: number },
) {
  return (
    <span class="swing">
      {pct(before)} → {pct(after)}{" "}
      <b class={by > 0 ? "up" : ""}>{signed(by)}</b>
    </span>
  );
}

/** the four figures a row shows, whichever question is being asked */
interface Figures {
  /** points the move is worth, a week over the season or in this one */
  points: number;
  /** the slot that changes hands, and who it changes hands with */
  slot: string;
  before: number;
  after: number;
  delta: number;
}

/**
 * Who takes the slot a drop hands over, across the drawn season.
 *
 * This column used to be headed "when he starts", with another player's
 * name under it, and two players in one phrase with no "he" attached to
 * either is a sentence nobody can read. Both the heading and the value
 * now name whoever inherits the slot.
 */
function seasonSlot(row: Drop): string {
  if (row.starts < RARELY_STARTS) {
    return "he rarely starts, so nobody";
  }

  const slot = row.slot ? slotName(row.slot) : "the lineup";

  return `${row.heir?.name ?? "a free agent"} at ${slot}`;
}

const seasonDrop = (row: Drop): Figures => ({
  points: -row.takes,
  slot: seasonSlot(row),
  before: row.before,
  after: row.after,
  delta: -row.costs,
});

const weekDrop = (
  his: WeekDrop, nameFor: (key: string) => string,
): Figures => ({
  points: -his.takes,
  slot: his.slot
    ? `${his.heir ? nameFor(his.heir) : "nobody"} at ${slotName(his.slot)}`
    : "he is not starting",
  before: his.before,
  after: his.after,
  delta: -his.costs,
});

const seasonAdd = (row: Add): Figures => ({
  points: row.brings,
  slot: row.displaced?.name ?? "an open starting spot",
  before: row.before,
  after: row.after,
  delta: row.added,
});

const weekAdd = (his: WeekAdd, nameFor: (key: string) => string): Figures => ({
  points: his.brings,
  slot: his.displaced
    ? `${nameFor(his.displaced)} at ${slotName(his.slot ?? "")}`
    : his.slot ? "an open starting spot" : "would not start",
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
      {at && <i>{at.slot ? "in at " + slotName(at.slot) : "benched"}</i>}
    </span>
  );
}

/** the figures, or a word saying why there are none to show */
function Figured(
  { figures, absent, slotLabel }: {
    figures: Figures | null;
    absent: string;
    /** what the slot column is called, since the two tables differ */
    slotLabel: string;
  },
) {
  if (!figures) {
    return (
      <>
        <td data-label="win %">{absent}</td>
        <td></td>
        <td></td>
      </>
    );
  }

  return (
    <>
      <td data-label="win %">
        <Swing
          before={figures.before} after={figures.after} by={figures.delta}
        />
      </td>
      <td data-label="pts">{points(figures.points)}</td>
      <td data-label={slotLabel}>{figures.slot}</td>
    </>
  );
}

/** what the add costs you, as the second half of the card's headline */
function addCost(paid: { drop: string } | null): string {
  if (!paid) {
    return "";
  }

  return paid.drop === OPEN_SPOT ? ", no drop needed" : ", drop " + paid.drop;
}

function AddRow(
  { row, at, figures, absent, paid, span, onMore }: {
    row: Add;
    /** where he is in this week's lineup, when the week is loaded */
    at: { slot: string | null } | null;
    figures: Figures | null;
    absent: string;
    /** who a spot for him costs and what the pair is worth, when priced */
    paid: { drop: string; net: number } | null;
    span: Span;
    onMore: () => void;
  },
) {
  return (
    <tr onClick={onMore}>
      {/* the move as you would say it, which a phone leads the card with
          and a wide screen has in its own columns already */}
      <td data-label="move" class="move">
        Add {row.p.name} ({row.p.position}){addCost(paid)}
      </td>
      <td data-label="player"><span class="who link">{row.p.name}</span></td>
      <td data-label="pos">{row.p.position}</td>
      {/* a season of him says nothing about one week, and the week's own
          figures are already the three cells after it */}
      {span === "season" && (
        <>
          <td data-label="ppg">{(row.p.ppg ?? 0).toFixed(1)}</td>
          <td data-label="starts"><Starting starts={row.starts} at={at} /></td>
        </>
      )}
      <Figured figures={figures} absent={absent} slotLabel="instead of" />
      <td data-label="drop">
        {paid ? <>{paid.drop} <b>{signed(paid.net)}</b></> : ""}
      </td>
    </tr>
  );
}

function DropRow(
  { row, at, figures, absent, slotLabel, span, onMore }: {
    row: Drop;
    at: { slot: string | null } | null;
    figures: Figures | null;
    absent: string;
    slotLabel: string;
    span: Span;
    onMore: () => void;
  },
) {
  return (
    <tr onClick={onMore}>
      <td data-label="move" class="move">
        Drop {row.p.name} ({row.p.position})
      </td>
      <td data-label="player"><span class="who link">{row.p.name}</span></td>
      <td data-label="pos">{row.p.position}</td>
      {span === "season" && (
        <>
          <td data-label="ppg">{(row.p.ppg ?? 0).toFixed(1)}</td>
          <td data-label="starts"><Starting starts={row.starts} at={at} /></td>
        </>
      )}
      <Figured figures={figures} absent={absent} slotLabel={slotLabel} />
    </tr>
  );
}

/**
 * Why this week has nothing to say yet, in the words a reader needs,
 * and whether it is something still arriving or something that will not.
 */
function missingWeek(
  week: number | null, rows: Map<string, SlateRow>,
  states: unknown, ours: unknown, gamesStatus = "",
): { says: string; reading: boolean } | null {
  if (week === null) {
    return {
      says: "No week has been built yet, so only the season figures are here.",
      reading: false,
    };
  }

  if (!rows.size) {
    return { says: "reading this week's projections...", reading: true };
  }

  if (!states) {
    return { says: "reading the scoreboard...", reading: true };
  }

  // a league whose games could not be read looks the same as one with no
  // game for you this week, and the reader can only fix the first
  if (!ours && gamesStatus) {
    return { says: gamesStatus, reading: false };
  }

  if (!ours) {
    return {
      says: "You have no game this week, so there is no lineup to price a " +
        "move against.",
      reading: false,
    };
  }

  return null;
}

/** the positions a reader filters by, the way the draft board lists them */
const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "K", "DEF"];

export function Waivers(props: Props) {
  const { players, league, posFilter, rows, games } = props;
  const [query, setQuery] = useState("");
  // before any week has been built there is nothing for the week to say,
  // so the page opens on the season instead of on a table of blanks
  const [span, setSpan] = useState<Span>(
    () => props.week === null ? "season" : "week");
  const { states, trouble } = useScoreboard(
    props.season ?? undefined, props.week ?? undefined);

  const { drops, listed, priced, working } = useWaiverPrices(
    players, league, props.schedule, posFilter);

  const lines: Lines = useMemo(
    () => new Map(players.map((p) => [p.key, p])), [players]);
  const ours = useMemo(
    () => myGameIn(games, league.team, league.userId), [games, league]);
  const nameFor = (key: string) => nameOf(key, rows, lines);

  /**
   * This week's own answer, for the whole roster and for the adds that have
   * a drop worked out. The players further down the list are priced over the
   * season only, since the week has to name the slot each one would take.
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
   * Only the top of the list has a drop worked out, and paying for a player
   * can only take value off him, so anybody adding less than the bar
   * cannot clear it once he is paid for either.
   */
  const worth = priced.filter(({ paid }) => paid.net >= WORTH_ADDING);
  const rest = listed.slice(PRICED).filter((row) => row.added >= WORTH_ADDING);
  const hidden = listed.length - worth.length - rest.length;
  const best = worth[0] ?? null;
  const wanted = normalizeName(query.trim());
  const paidFor = new Map(priced.map(({ row, paid }) => [row.p.key, paid]));

  /**
   * The adds worth showing, in the order the span asks for. This week
   * leads with what a move does to your win probability and drops
   * everybody it does nothing for, since a list led by five tight ends
   * worth zero is a list nobody reads.
   */
  const adds = useMemo(() => {
    const every = [...worth.map(({ row }) => row), ...rest]
      .filter((row) => !wanted || normalizeName(row.p.name).includes(wanted))
      .map((row) => ({ row, paid: paidFor.get(row.p.key) ?? null }));

    if (span === "season") {
      return every;
    }

    return every
      .map((one) => ({
        ...one, by: week?.adds.get(one.row.p.key)?.added ?? 0,
      }))
      .filter((one) => one.by !== 0)
      .sort((a, b) => b.by - a.by);
  }, [worth, rest, wanted, span, week]);

  const yours = drops
    .filter((row) => !wanted || normalizeName(row.p.name).includes(wanted));
  const missing = missingWeek(
    props.week, rows, states, ours, props.gamesStatus);
  const dropSlot = "who takes his slot";

  /**
   * A row with no week figures says which of the two reasons it is: the
   * week itself has not loaded, or it has and nobody has a line on him.
   */
  const absent = week ? "no projection" : "no week yet";

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
          ? { drop: paid.drop?.name ?? OPEN_SPOT, net: paid.net }
          : null,
      };
    }

    return {
      at: his,
      absent,
      figures: his ? weekAdd(his, nameFor) : null,
      paid: net
        ? {
            drop: net.drop ? nameFor(net.drop) : OPEN_SPOT,
            net: net.net,
          }
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

  /**
   * The controls stay put whatever the page is doing underneath, so the
   * span you picked does not vanish while the season is being priced.
   */
  const controls = (
    <div class="controls">
      <span class="seg" role="tablist">
        {SPANS.map(([which, said]) => (
          <button
            key={which}
            role="tab"
            aria-selected={span === which}
            class={span === which ? "on" : ""}
            onClick={() => setSpan(which)}
          >
            {said}
          </button>
        ))}
      </span>

      {span !== "ranks" && props.onPosFilter && (
        <span class="chips">
          {POSITIONS.map((where) => (
            <button
              key={where}
              class={where === posFilter ? "on" : ""}
              onClick={() => props.onPosFilter!(where)}
            >
              {where.toLowerCase()}
            </button>
          ))}
        </span>
      )}

      {span !== "ranks" && (
        <>
          <input
            class="find"
            type="search"
            placeholder="find a name"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <span class="says">
            {span === "season"
              ? "a full season of simulated weeks against an average opponent"
              : week
                ? "the lineup you would set against " + week.opponent +
                  ", and your win probability either way"
                : "this week's game, once the week has loaded"}
          </span>
        </>
      )}
    </div>
  );

  if (span === "ranks") {
    return (
      <>
        {controls}
        <WeekRanks
          slate={props.slate}
          rows={rows}
          roster={props.roster}
          listed={props.listed}
        />
      </>
    );
  }

  if (working) {
    return (
      <>
        {controls}
        <Reading>pricing the waiver wire against your season</Reading>
      </>
    );
  }

  if (!drops.length) {
    return (
      <>
        {controls}
        <div class="empty">
          <b>Nobody on your roster yet.</b> Once your league has a team for
          you, this says what each free agent would add.
        </div>
      </>
    );
  }

  return (
    <>
      {controls}

      {span === "week" && missing && (missing.reading
        ? <Reading>{missing.says}</Reading>
        : <p class="hint">{missing.says}</p>)}
      {span === "week" && trouble && <p class="hint">{trouble}</p>}

      <h2>waiver wire adds</h2>
      <table class="line pairs">
        <thead>
          <tr>
            <th>player</th>
            <th>pos</th>
            {span === "season" && <th>ppg</th>}
            {span === "season" && <th>starts</th>}
            <th>win %</th>
            <th>{span === "week" ? "pts" : "pts a week"}</th>
            <th>instead of</th>
            <th>drop</th>
          </tr>
        </thead>
        <tbody>
          {adds.map(({ row, paid }) => (
            <AddRow
              key={row.p.key}
              row={row}
              span={span}
              {...addSeen(row, paid)}
              onMore={() => props.onMore(row.p)}
            />
          ))}
        </tbody>
      </table>

      {adds.length === 0 && (
        <p class="hint">
          {span === "week"
            ? "No add moves your win % this week."
            : "No matches."}
        </p>
      )}

      {hidden > 0 && (
        <p class="hint" title={"they came out under half a point of win " +
          "probability a week, which is inside the noise"}>
          {hidden} hidden
        </p>
      )}

      <h2>what dropping each of yours costs</h2>
      <table class="line pairs">
        <thead>
          <tr>
            <th>player</th>
            <th>pos</th>
            {span === "season" && <th>ppg</th>}
            {span === "season" && <th>starts</th>}
            <th>win %</th>
            <th>{span === "week" ? "pts" : "pts a week"}</th>
            <th>{dropSlot}</th>
          </tr>
        </thead>
        <tbody>
          {yours.map((row) => (
            <DropRow
              key={row.p.key}
              row={row}
              slotLabel={dropSlot}
              span={span}
              {...dropSeen(row)}
              onMore={() => props.onMore(row.p)}
            />
          ))}
        </tbody>
      </table>

      {!best && (
        <p class="hint">
          No add is worth a drop right now.
        </p>
      )}

      {best && (
        <p class="hint">
          {best.paid.drop
            ? (
              <>
                Best move: add <b>{best.row.p.name}</b>, drop{" "}
                <b>{best.paid.drop.name}</b>. Win %{" "}
                {pct(best.paid.before)} to {pct(best.paid.after)}.
              </>
            )
            : (
              <>
                Best move: add <b>{best.row.p.name}</b> to your open spot.
                Win % {pct(best.paid.before)} to {pct(best.paid.after)}.
              </>
            )}
        </p>
      )}
    </>
  );
}

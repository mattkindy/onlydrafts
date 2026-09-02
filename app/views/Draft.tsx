/**
 * Who to take next, and the whole board behind it.
 *
 * The cards show the handful worth taking now, with your own turns
 * drawn where they fall. The table under them is the same order in
 * full, for looking someone up or seeing how far a run has gone.
 */

import { useState } from "preact/hooks";

import type { Player } from "../lib/scoring.ts";
import { asRound, expectedBestAt, type Draft as DraftPicks } from "../lib/picks.ts";
import { openingsAfter, stillNeeded, type Openings } from "../lib/need.ts";
import { finishRange } from "../lib/finish.ts";
import { takeNowFor, typicalWeek, type WinShare } from "../lib/winShare.ts";
import { STREAMED } from "../lib/replacementPool.ts";
import { SeasonCard, seasonScale } from "./Card.tsx";

export interface Pick {
  overall: number;
  round: number;
  slot: number;
  name: string;
  position: string;
  /** the side, without which a defence matches nothing on the board */
  team?: string | null;
  who: string;
  mine: boolean;
  keeper: boolean;
}

export interface DraftNow {
  taken: Set<string>;
  mine: Set<string>;
  /** who took each man */
  teams: Record<string, string>;
  /** and who had him last season */
  rosteredBy: Record<string, string>;
  grid: { teams: number; rounds: number; mySlot: number | null; cells: Record<string, string> } | null;
  /** every pick so far, in the order they were made */
  made?: Pick[];
  pickCount?: number;
  /** the overall slots a pick already fills, keepers included */
  filled?: number[];
  status?: string;
  clock?: { who: string; mine: boolean; overall: number; untilMine: number | null };
  /** who the league office has listed, by the board's own key */
  hurt?: Record<string, { status: string; part?: string }>;
}

/**
 * What the league office says about him, short enough for a card.
 *
 * Sleeper writes these as Questionable, Doubtful, Out, IR, PUP, Sus and
 * a few others. The word alone is the news; the body part goes on the
 * hover, since a card has no room for it and a reader who cares will
 * ask.
 */
const WORRYING = new Set(["Out", "IR", "PUP", "Sus", "NA", "Doubtful", "DNR"]);

export function injuryBadge(
  hurt: { status: string; part?: string } | undefined,
): { badge: string; badgeHow: string; badgeTitle: string } | null {
  if (!hurt?.status) {
    return null;
  }

  return {
    badge: hurt.status.toLowerCase(),
    badgeHow: WORRYING.has(hurt.status) ? "bad" : "warn",
    badgeTitle: hurt.part ? `${hurt.status}, ${hurt.part}` : hurt.status,
  };
}

interface Props {
  men: Player[];
  state: DraftNow;
  teams: number;
  snake: boolean;
  posFilter: string;
  query: string;
  /** the weeks he wins you, our own value, or where the room takes him */
  order: "war" | "rank" | "adp";
  onMore: (p: Player) => void;
  staleAt?: string;
  /** the lineup this league starts, for working out what you still need */
  slots?: string[] | null;
  /** hide men who cannot start for you yet */
  needOnly?: boolean;
}

export function matchesFilter(p: Player, posFilter: string) {
  if (posFilter === "ALL") {
    return true;
  }

  if (posFilter === "FLEX") {
    return ["RB", "WR", "TE"].includes(p.position);
  }

  if (posFilter === "ROOKIES") {
    return Boolean(p.rookie);
  }

  return p.position === posFilter;
}

/**
 * Every turn of yours still to come, in draft order, each with how
 * many picks other people make first. Slots a keeper already fills are
 * skipped on both counts.
 */
function myUpcomingPicks(
  grid: DraftNow["grid"], fromOverall: number, filled: Set<number>,
) {
  if (!grid?.mySlot) {
    return [];
  }

  const picks: {
    overall: number; round: number; label: string; after: number;
  }[] = [];
  let toCome = 0;

  for (let n = fromOverall; n <= grid.teams * grid.rounds; n++) {
    if (filled.has(n)) {
      continue;
    }

    const round = Math.ceil(n / grid.teams);
    const inRound = n - (round - 1) * grid.teams;
    const slot = round % 2 === 1 ? inRound : grid.teams - inRound + 1;

    if (slot === grid.mySlot) {
      picks.push({
        overall: n,
        round,
        label: round + "." + String(grid.mySlot).padStart(2, "0"),
        after: toCome,
      });
    }

    toCome++;
  }

  return picks;
}

/**
 * What taking him now is worth over waiting a turn.
 *
 * Value over replacement does not move as a draft runs: the last back
 * this league starts is the same man whether or not the ten above him
 * have gone. What moves is how far the position falls before your next
 * turn. When backs are flying off, the best one left when you pick
 * again is much worse, and taking one now is worth that gap.
 */
function dropOffBy(men: Player[], draft: DraftPicks, nextTurn: number | null) {
  if (!nextTurn) {
    return () => 0;
  }

  const atPosition = new Map<string, number>();

  return (p: Player) => {
    if (!atPosition.has(p.position)) {
      atPosition.set(
        p.position,
        expectedBestAt(men, nextTurn, draft, null, p.position),
      );
    }

    return (p.vor ?? 0) - atPosition.get(p.position)!;
  };
}

/**
 * The slots you still have to fill, and what the rest of the room still
 * needs at each position. The second half is the one you cannot get
 * from your own roster page: four teams still wanting a tight end is
 * how a run starts.
 */
function StillNeeded(
  { open, state, teams }: {
    open: Openings; state: DraftNow; teams: number;
  },
) {
  const WHERE = ["QB", "RB", "WR", "TE", "K", "DEF"];
  /** how many at each position the room has taken, so a run is visible */
  const gone: Record<string, number> = {};

  for (const pick of state.made ?? []) {
    gone[pick.position] = (gone[pick.position] ?? 0) + 1;
  }

  return (
    <div class="needs">
      <div class="line">
        <span class="over">you still need</span>
        {WHERE.map((where) => {
          const mine = open.named[where] ?? 0;

          return mine > 0
            ? <span class="f" key={where}><i>{where}</i>{mine}</span>
            : null;
        })}
        {open.flex > 0 && <span class="f"><i>flex</i>{open.flex}</span>}
        {open.full && <span class="f">your lineup is full</span>}
      </div>
      <div class="line">
        <span class="over">taken so far</span>
        {WHERE.map((where) => (
          <span class="f" key={"gone" + where}>
            <i>{where}</i>{gone[where] ?? 0}
            <small>of {teams}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

function Clock({ state, teams }: { state: DraftNow; teams: number }) {
  const { status, clock } = state;

  if (!status && !clock) {
    return null;
  }

  if (status === "complete") {
    return <div class="clock"><div class="big">Draft complete</div></div>;
  }

  if (status === "drafting" && clock) {
    return (
      <div class="clock">
        <div class="big">
          {clock.mine ? "You are on the clock" : clock.who + " is picking"}
        </div>
        <div class="sub">
          {asRound(clock.overall, teams)}
          {clock.untilMine !== null && !clock.mine &&
            ` · ${clock.untilMine} until your turn`}
        </div>
      </div>
    );
  }

  return (
    <div class="clock">
      <div class="big">Draft has not started</div>
      <div class="sub">
        {state.grid?.mySlot
          ? "you pick from slot " + state.grid.mySlot
          : "waiting for the commissioner"}
      </div>
    </div>
  );
}

/** how many cards the whole board opens with, and steps by */
const A_PAGE = 60;

/**
 * How many weeks to draw when the board is scored by what a man adds to
 * your wins. A dozen rosters are drawn for the whole board and this
 * many weeks takes under a tenth of a second on a laptop, so the page
 * keeps up with a draft that redraws every ten seconds. The difference
 * it reads is paired, both sides drawing the same weeks, so it is
 * steadier than the count on its own suggests.
 */
const WEEKS_DRAWN = 2000;

interface Scored {
  p: Player;
  score: number;
  drop: number;
  need: WinShare | null;
}

/**
 * One list, best first, however far down you care to read.
 *
 * There used to be a shortlist of the next two dozen above this, from
 * when the whole board was a table and cards were the only place a man
 * was drawn properly. Both said the same thing in the same order, so
 * the shortlist went and what was worth keeping came here: your turns
 * drawn where they fall, and the note on why a man is worth taking now.
 */
function FullRankings(
  {
    scored, gone, board, state, teams, posFilter, order, byNeed, lineAfter,
    staleAt, onMore,
  }:
  {
    scored: Scored[]; gone: Player[]; board: Player[]; state: DraftNow;
    teams: number; posFilter: string; order: "war" | "rank" | "adp";
    byNeed: boolean; lineAfter: Map<number, string>; staleAt?: string;
    onMore: (p: Player) => void;
  },
) {
  // cards by default, a page at a time, since seven hundred at once is
  // slow and the table stays for looking a man up
  const [how, setHow] = useState<"cards" | "table">("cards");
  const [shown, setShown] = useState(A_PAGE);

  // the ones already drafted keep their place, after the men you can have
  const men = scored.map(({ p }) => p);
  const all = [...men, ...gone];
  const left = all.filter((p) => !state.taken.has(p.key)).length;
  const page = scored.slice(0, shown);
  const max = seasonScale(page.map(({ p }) => p));

  return (
    <>
      <h2>
        who to take
        {posFilter !== "ALL" && ", " + posFilter.toLowerCase() + " only"}
        {staleAt && " as of " + staleAt}
      </h2>
      <p class="hint">{left} of {all.length} still on the board</p>
      <div class="how noprint">
        <button
          class={how === "cards" ? "on" : ""}
          onClick={() => setHow("cards")}
        >
          cards
        </button>
        <button
          class={how === "table" ? "on" : ""}
          onClick={() => setHow("table")}
        >
          table
        </button>
      </div>

      {how === "cards" && (
        <>
          <div class="cards">
            {page.map(({ p, score, drop, need }, i) => (
              <>
                {lineAfter.has(i) && (
                  <div class="pickline" key={"line" + i}>
                    <span>your {lineAfter.get(i)}</span>
                  </div>
                )}
                <SeasonCard
                  key={p.key}
                  p={p}
                  max={max}
                  teams={teams}
                  lead={order}
                  wins={need ? (need.added * 100).toFixed(1) + "%" : undefined}
                  teamsInLeague={teams}
                  finish={finishRange(p, board)}
                  mine={state.mine.has(p.key)}
                  {...(injuryBadge(state.hurt?.[p.key]) ?? {})}
                  // the weeks he wins you lead the card when they are
                  // the order, so what is left down here is his value
                  aside={STREAMED.has(p.position)
                      /**
                       * You have to start a kicker and a defence, so
                       * what a pick here is worth is the wrong question
                       * for them: there is no lineup without one. What
                       * he beats the man off waivers by is the whole
                       * decision, and it is a different number.
                       */
                      ? { label: "over the wire", value: (p.ownVor ?? 0).toFixed(1) }
                      : { label: "value here", value: score.toFixed(1) }}
                  tag={byNeed && need
                    ? need.starts < 0.05
                      ? "you would never start him over what you have"
                      : need.starts < 0.9
                        ? `you would start him ${Math.round(need.starts * 100)}% of weeks`
                        : "he starts every week you have him"
                    : i < 3
                      ? "best left at " + p.position
                      : state.rosteredBy[p.key]
                        ? "was on " + state.rosteredBy[p.key] + " last season"
                        : drop > 8
                          ? `waiting a turn costs ${drop.toFixed(0)} at ${p.position}`
                          : ""}
                  warn={i >= 3 && Boolean(state.rosteredBy[p.key])}
                  onMore={() => onMore(p)}
                />
              </>
            ))}
          </div>
          {shown < scored.length && (
            <div class="row">
              <button onClick={() => setShown((n) => n + A_PAGE)}>
                show {Math.min(A_PAGE, scored.length - shown)} more
              </button>
            </div>
          )}
        </>
      )}

      {how === "table" && (
      <div class="scroll">
        <table class="ranks">
          <thead>
            <tr>
              <th>ours</th><th>player</th><th>pts</th>
              <th title="games we expect him to play">gms</th>
              <th title="what he is worth over a season, above the last man this league starts at his position">value</th>
              <th>adp</th><th>bye</th><th></th>
            </tr>
          </thead>
          <tbody>
            {all.map((p) => {
              const isGone = state.taken.has(p.key);
              const isMine = state.mine.has(p.key);
              const who = state.teams[p.key];

              return (
                <tr
                  key={p.key}
                  class={isMine ? "mine" : isGone ? "gone" : ""}
                  onClick={() => onMore(p)}
                >
                  <td class="n">{p.rank ? asRound(p.rank, teams) : ""}</td>
                  <td>
                    <b>{p.name}</b>{" "}
                    <span class="pos">{p.position} &middot; {p.team ?? ""}</span>
                    {state.hurt?.[p.key] && (
                      <span
                        class={"badge " +
                          (injuryBadge(state.hurt[p.key])?.badgeHow ?? "")}
                        title={injuryBadge(state.hurt[p.key])?.badgeTitle}
                      >
                        {injuryBadge(state.hurt[p.key])?.badge}
                      </span>
                    )}
                  </td>
                  <td class="n">{(p.game?.["ev"] ?? p.ppg)?.toFixed(1) ?? ""}</td>
                  <td class="n">{p.games?.toFixed(1) ?? ""}</td>
                  <td class="n">{p.vor ?? ""}</td>
                  <td class="n">{p.adp ? asRound(p.adp, teams) : "—"}</td>
                  <td class="n">{p.bye ?? ""}</td>
                  <td class="mark">
                    {isMine
                      ? <span class="up" title="yours">★</span>
                      : isGone
                        ? <span class="pos" title={who ? "taken by " + who : "taken"}>×</span>
                        : <span class="up" title="still on the board">✓</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </>
  );
}

/** what the room has taken so far, newest first */
function PicksSoFar({ made, teams }: { made: Pick[]; teams: number }) {
  if (!made.length) {
    return null;
  }

  return (
    <>
      <h2>picks so far ({made.length})</h2>
      <div class="scroll">
        <table class="ranks">
          <thead>
            <tr><th>pick</th><th>player</th><th>to</th></tr>
          </thead>
          <tbody>
            {[...made].reverse().map((p) => (
              <tr key={p.overall} class={p.mine ? "mine" : ""}>
                <td class="n">{asRound(p.overall, teams)}</td>
                <td>
                  <b>{p.name}</b> <span class="pos">{p.position}</span>
                  {p.keeper && <span class="chip">keeper</span>}
                </td>
                <td>{p.who}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PickGrid({ grid }: { grid: NonNullable<DraftNow["grid"]> }) {
  const slots = Array.from({ length: grid.teams }, (_, i) => i + 1);
  const rounds = Array.from({ length: grid.rounds }, (_, i) => i + 1);

  return (
    <>
      <h2>pick grid</h2>
      <table class="grid">
        <tbody>
          <tr>
            <th></th>
            {slots.map((slot) => (
              <th key={slot}>{slot === grid.mySlot ? "you" : slot}</th>
            ))}
          </tr>
          {rounds.map((round) => (
            <tr key={round}>
              <th>r{round}</th>
              {slots.map((slot) => (
                <td key={slot} class={slot === grid.mySlot ? "me" : ""}>
                  {grid.cells[round + "|" + slot] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function DraftView(props: Props) {
  const { men, state, teams, posFilter, query } = props;
  const draft: DraftPicks = {
    teams,
    slot: state.grid?.mySlot ?? null,
    snake: props.snake,
    taken: state.taken,
  };
  /**
   * Your turn after this one. Everything at a position can be had until
   * then, so what a man is worth taking now is the gap between him and
   * whoever is left when you come back.
   */
  const upcoming = myUpcomingPicks(
    state.grid, state.clock?.overall ?? 1, new Set(state.filled ?? []),
  );
  const dropOff = dropOffBy(men, draft, upcoming[1]?.overall ?? null);
  const wanted = (p: Player) =>
    matchesFilter(p, posFilter) && (!query || p.key.includes(query));

  const drafted = men.filter((p) => state.mine.has(p.key));
  const open = openingsAfter(props.slots, drafted);
  const left = men.filter((p) => !state.taken.has(p.key));
  /**
   * What taking him now would add to how often you win a week, with the
   * rest of your draft filled in around him. It replaces a points
   * measure that could not say why a first kicker is worth anything or
   * a fifth back is worth something.
   */
  /**
   * Your turns still to come. Before the commissioner starts the draft
   * there is no grid and so no turns, and with none of them the seats
   * never get filled: every man on the board then reads a fraction of a
   * percent and the order is noise. So a plain schedule fills in, one
   * turn a round from the middle of the room.
   */
  const rounds = props.slots?.length ?? 15;
  const turns = upcoming.length
    ? upcoming.map((u) => u.overall)
    : Array.from(
      { length: rounds },
      (_, r) => r * teams + Math.ceil(teams / 2),
    );

  const worth = props.order === "war"
    ? takeNowFor(
      drafted, props.slots, left, turns,
      typicalWeek(men, props.slots, teams, WEEKS_DRAWN), WEEKS_DRAWN,
    )
    : null;

  const scored = left
    .filter(wanted)
    .filter((p) => !props.needOnly || stillNeeded(p.position, open))
    .map((p) => ({
      p, score: p.vor ?? 0, drop: dropOff(p), need: worth?.(p) ?? null,
    }))
    /**
     * By the board, or by what he adds to your lineup once the slots
     * you have left are counted. A man the need score cannot speak for,
     * because too few at his slot are priced, keeps his place on the
     * board rather than being dropped to the bottom of the list.
     */
    .sort((a, b) => {
      if (props.order === "war" && a.need && b.need) {
        return b.need.added - a.need.added;
      }

      return props.order === "adp"
        ? (a.p.adp ?? 999) - (b.p.adp ?? 999)
        : (a.p.rank ?? 9999) - (b.p.rank ?? 9999);
    });

  const counted = drafted.reduce<Record<string, number>>((tally, p) => {
    tally[p.position] = (tally[p.position] ?? 0) + 1;

    return tally;
  }, {});

  /**
   * Your turn drawn where it falls. Everyone above a line is expected
   * to be gone by then, so the line comes after as many cards as there
   * are picks before yours, less whoever has already been taken.
   */
  const lineAfter = new Map<number, string>();
  let nextPick = 0;

  for (let shown = 0; shown < scored.length; shown++) {
    while (nextPick < upcoming.length &&
      shown >= upcoming[nextPick]!.after) {
      lineAfter.set(shown, upcoming[nextPick]!.label);
      nextPick++;
    }
  }

  return (
    <>
      <Clock state={state} teams={teams} />
      <StillNeeded open={open} state={state} teams={teams} />

      <FullRankings
        scored={scored}
        board={men}
        order={props.order}
        byNeed={props.order === "war"}
        lineAfter={lineAfter}
        gone={men.filter((p) => state.taken.has(p.key)).filter(wanted)}
        state={state}
        teams={teams}
        posFilter={posFilter}
        staleAt={props.staleAt}
        onMore={props.onMore}
      />

      <PicksSoFar made={state.made ?? []} teams={teams} />

      {state.grid && <PickGrid grid={state.grid} />}

      <h2>
        {drafted.length
          ? "you drafted (" + Object.entries(counted)
              .map(([pos, n]) => n + " " + pos).join(", ") + ")"
          : "your draft roster"}
      </h2>
      {drafted.length === 0
        ? (
          <div class="empty">
            Nothing yet. Mark keepers from <b>my roster</b> or from the
            cards here, and your picks land here as the draft runs.
          </div>
        )
        : (
          <div class="cards">
            {drafted.map((p) => (
              <SeasonCard
                key={p.key}
                p={p}
                max={seasonScale(drafted)}
                teams={teams}
                mine
                onMore={() => props.onMore(p)}
              />
            ))}
          </div>
        )}
    </>
  );
}

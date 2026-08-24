/**
 * Who to take next, and the whole board behind it.
 *
 * The cards show the handful worth taking now, with your own turns
 * drawn where they fall. The table under them is the same order in
 * full, for looking someone up or seeing how far a run has gone.
 */

import type { Player } from "../lib/scoring.ts";
import { asRound, expectedBestAt, type Draft as DraftPicks } from "../lib/picks.ts";
import { SeasonCard, seasonScale } from "./Card.tsx";

/** how many the shortlist shows before the full rankings take over */
const MOST_SHOWN = 24;

export interface Pick {
  overall: number;
  round: number;
  slot: number;
  name: string;
  position: string;
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
  status?: string;
  clock?: { who: string; mine: boolean; overall: number; untilMine: number | null };
}

interface Props {
  men: Player[];
  state: DraftNow;
  teams: number;
  snake: boolean;
  posFilter: string;
  query: string;
  order: "rank" | "adp";
  onMore: (p: Player) => void;
  staleAt?: string;
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

/** every turn of yours still to come, in draft order */
function myUpcomingPicks(grid: DraftNow["grid"], fromOverall: number) {
  if (!grid?.mySlot) {
    return [];
  }

  const picks: { overall: number; round: number; label: string }[] = [];

  for (let n = fromOverall; n <= grid.teams * grid.rounds; n++) {
    const round = Math.ceil(n / grid.teams);
    const inRound = n - (round - 1) * grid.teams;
    const slot = round % 2 === 1 ? inRound : grid.teams - inRound + 1;

    if (slot === grid.mySlot) {
      picks.push({
        overall: n,
        round,
        label: round + "." + String(grid.mySlot).padStart(2, "0"),
      });
    }
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

function FullRankings(
  { men, gone, state, teams, posFilter, onMore }:
  {
    men: Player[]; gone: Player[]; state: DraftNow; teams: number;
    posFilter: string; onMore: (p: Player) => void;
  },
) {
  // the ones already drafted keep their place, after the men you can have
  const all = [...men, ...gone];
  const left = all.filter((p) => !state.taken.has(p.key)).length;

  return (
    <>
      <h2>
        the whole board
        {posFilter !== "ALL" && ", " + posFilter.toLowerCase() + " only"}
      </h2>
      <p class="hint">{left} of {all.length} still on the board</p>
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
  const upcoming = myUpcomingPicks(state.grid, state.clock?.overall ?? 1);
  const dropOff = dropOffBy(men, draft, upcoming[1]?.overall ?? null);
  const wanted = (p: Player) =>
    matchesFilter(p, posFilter) && (!query || p.key.includes(query));

  const scored = men
    .filter((p) => !state.taken.has(p.key))
    .filter(wanted)
    .map((p) => ({ p, score: p.vor ?? 0, drop: dropOff(p) }))
    // our value and our order are the same thing now: what a pick at
    // his place on the board is worth
    .sort((a, b) => props.order === "adp"
      ? (a.p.adp ?? 999) - (b.p.adp ?? 999)
      : (a.p.rank ?? 9999) - (b.p.rank ?? 9999));

  const shortlist = scored.slice(0, MOST_SHOWN);
  const max = seasonScale(shortlist.map(({ p }) => p));
  const drafted = men.filter((p) => state.mine.has(p.key));
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

  for (let shown = 0; shown < shortlist.length; shown++) {
    while (nextPick < upcoming.length &&
      shown >= Math.max(0, upcoming[nextPick]!.overall - 1 - (state.pickCount ?? 0))) {
      lineAfter.set(shown, upcoming[nextPick]!.label);
      nextPick++;
    }
  }

  return (
    <>
      <Clock state={state} teams={teams} />
      <h2>
        best available for your draft roster
        {props.staleAt && " as of " + props.staleAt}
      </h2>
      <div class="cards">
        {shortlist.map(({ p, score, drop }, i) => (
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
              aside={{ label: "value here", value: score.toFixed(1) }}
              tag={i < 3
                ? "best left at " + p.position
                : state.rosteredBy[p.key]
                  ? "was on " + state.rosteredBy[p.key] + " last season"
                  : drop > 8
                    ? `waiting a turn costs ${drop.toFixed(0)} at ${p.position}`
                    : ""}
              warn={i >= 3 && Boolean(state.rosteredBy[p.key])}
              onMore={() => props.onMore(p)}
            />
          </>
        ))}
      </div>

      <FullRankings
        men={scored.map(({ p }) => p)}
        gone={men.filter((p) => state.taken.has(p.key)).filter(wanted)}
        state={state}
        teams={teams}
        posFilter={posFilter}
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

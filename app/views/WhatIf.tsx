/**
 * The trades in the what-if, and the line that says what it includes.
 *
 * The stats tab keeps every what-if control in its own section: the
 * trades, your scoring and the results you pick. Over the playoff table
 * goes one line saying what the odds include, since a pending trade
 * counts without anybody asking for it. The trade tab folds the same
 * list into one line over the result, because the result is what that
 * page is for and a phone has room for one thing at the top.
 *
 * Switching a trade off keeps it listed, so with and without it is two
 * taps apart. Only your own trades can be edited or removed; the league's
 * go when the league processes them, and then they are in the rosters.
 */

import { useState } from "preact/hooks";

import type { League } from "../lib/providers.ts";
import {
  isOn, movesOf, moveToDeal, teamsIn, toggled, whoGetsWhat,
  type Move, type PickMove, type Scenario, type Stale,
} from "../lib/scenario.ts";
import { ordinal } from "./Standings.tsx";

/** the what-if both tabs share, and what changes it */
export interface WhatIfState {
  scenario: Scenario;
  /** the league after the moves switched on, which went in, and which were skipped */
  world: { league: League; applied: Move[]; stale: Stale[] };
  onScenario: (next: Scenario) => void;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** a pick in a move, as a manager says it: "2027 1st", with whose it was where that matters */
const pickSays = (p: PickMove, me: string) =>
  `${p.season} ${ordinal(p.round)}` +
  (p.original !== p.giver ? ` (${p.original === me ? "yours" : p.original})` : "");

/** the teams in a move, you first and called you */
export const moveTitle = (move: Move, me: string) =>
  teamsIn(move, me).map((t) => (t === me ? "you" : t)).join(" ⇄ ");

/**
 * What a move does, a line each: what you get and what you give where
 * you are in it, and what each team gets where you are not.
 */
export function moveLines(move: Move, me: string): string[] {
  const names = (players: { name: string }[], picks: PickMove[]) =>
    [...players.map((p) => p.name), ...picks.map((p) => pickSays(p, me))].join(", ");

  if (teamsIn(move).includes(me)) {
    const get = names(move.players.filter((p) => p.to === me), move.picks.filter((p) => p.to === me));
    const give = names(
      move.players.filter((p) => p.from === me && p.to !== null),
      move.picks.filter((p) => p.giver === me),
    );
    const drop = names(move.players.filter((p) => p.from === me && p.to === null), []);

    return [get && `get ${get}`, give && `give ${give}`, drop && `drop ${drop}`].filter(Boolean);
  }

  return whoGetsWhat(move).flatMap((t) => [
    t.players.length || t.picks.length ? `${t.owner} gets ${names(t.players, t.picks)}` : "",
    t.cuts.length ? `${t.owner} drops ${names(t.cuts, [])}` : "",
  ]).filter(Boolean);
}

/**
 * What the odds include beyond the league as it stands, in a few words,
 * or nothing when they include nothing. `short` fits one line of a phone:
 * the trades counted together, whoever made them.
 */
export function whatIfSays(league: League, whatIf: WhatIfState, short = false): string {
  const { scenario, world } = whatIf;
  const pending = world.applied.filter((m) => m.by === "league").length;
  const yours = world.applied.length - pending;
  const nudge = scenario.nudge
    ? `${scenario.nudge > 0 ? "+" : "−"}${Math.round(Math.abs(scenario.nudge) * 100)}%`
    : "";

  return (short
    ? [
        world.applied.length ? plural(world.applied.length, "trade") : "",
        scenario.results.size ? plural(scenario.results.size, "result") : "",
        nudge && `you ${nudge}`,
      ]
    : [
        pending ? plural(pending, "pending trade") : "",
        yours ? plural(yours, "trade") + " you added" : "",
        scenario.results.size ? plural(scenario.results.size, "picked result") : "",
        nudge && `your scoring ${nudge}`,
      ]).filter(Boolean).join(", ");
}

/** the league as it stands: every trade switched off, still listed, and nothing picked */
export function asItStands(league: League, scenario: Scenario): Scenario {
  const on = movesOf(league, scenario).filter((m) => isOn(m, scenario)).map((m) => m.id);

  return { ...scenario, results: new Map(), nudge: 0, off: [...new Set([...scenario.off, ...on])], on: [] };
}

/** how a trade stands: the league's waiting to go through, or one of yours */
const tagOf = (move: Move) =>
  move.by === "you" ? "yours" : move.status === "pending" ? "pending" : move.status ?? "pending";

/** every trade in the what-if, a row each with its switch */
export function WhatIfTrades(props: {
  league: League;
  whatIf: WhatIfState;
  /** one of your trades opened on the trade tab to change */
  onEdit?: ((move: Move) => void) | undefined;
  /** the trade being changed on the trade tab, which says so on its row */
  editing?: string | null | undefined;
  /** opens the trade tab to build one */
  onAdd?: (() => void) | undefined;
}) {
  const { league, whatIf } = props;
  const { scenario, world, onScenario } = whatIf;
  const me = league.team;
  const moves = movesOf(league, scenario);
  const skipped = new Map(world.stale.map((s) => [s.move.id, s.missing]));

  return (
    <div class="witrades">
      {moves.length
        ? (
          <ul class="wimoves">
            {moves.map((move) => {
              const on = isOn(move, scenario);
              const why = on ? skipped.get(move.id) : undefined;
              const title = moveTitle(move, me);
              const lines = moveLines(move, me);

              return (
                <li key={move.id} class={on && !why ? "on" : "off"}>
                  <button
                    class="wiswitch" role="switch" aria-checked={on}
                    aria-label={`include ${title}`}
                    onClick={() => onScenario(toggled(scenario, move))}
                  />
                  <div class="wibody">
                    <p class="witeams">
                      {title}
                      <span class={"wiby " + tagOf(move)}>
                        {props.editing === move.id ? "editing" : tagOf(move)}
                      </span>
                    </p>
                    {(lines.length ? lines : ["no players or picks"]).map((line) => (
                      <p class="widetail" key={line}>{line}</p>
                    ))}
                    {why && <p class="wistale">skipped: {why}</p>}
                    {move.by === "you" && props.editing !== move.id && (
                      <div class="wiacts">
                        {props.onEdit && moveToDeal(move, me) && (
                          <button class="quiet" onClick={() => props.onEdit!(move)}>edit</button>
                        )}
                        <button
                          class="quiet" aria-label={`remove ${title}`}
                          onClick={() => onScenario({
                            ...scenario,
                            moves: scenario.moves.filter((m) => m.id !== move.id),
                            off: scenario.off.filter((id) => id !== move.id),
                          })}
                        >
                          remove
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )
        : <p class="hint">No trades yet. Pending trades in your league show up here on their own.</p>}
      {props.onAdd && <button class="quiet wiadd" onClick={props.onAdd}>add a trade</button>}
    </div>
  );
}

/**
 * The what-if folded into one line, for the trade tab: what it includes,
 * and a tap opens the trades in it. Nothing at all when it is empty.
 */
export function WhatIfLine(props: {
  league: League;
  whatIf: WhatIfState;
  onEdit?: ((move: Move) => void) | undefined;
  editing?: string | null | undefined;
  /** opens the stats tab, where the what-if is played out in full */
  onSeeOdds?: (() => void) | undefined;
}) {
  const { league, whatIf } = props;
  const [open, setOpen] = useState(false);
  const says = whatIfSays(league, whatIf, true);
  const listed = movesOf(league, whatIf.scenario).length;

  if (!listed && !says) {
    return null;
  }

  return (
    <section class={"whatif" + (open ? " open" : "")} aria-label="what if">
      <button class="wisummary" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <b>what if</b>
        <span class={says ? "on" : ""}>
          {says ? `includes ${says}` : `${plural(listed, "trade")}, all off`}
        </span>
        <svg
          class={"chev" + (open ? " open" : "")}
          viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
          />
        </svg>
      </button>
      {open && (
        <>
          <WhatIfTrades {...props} />
          <div class="wifoot">
            {props.onSeeOdds && (
              <button class="quiet" onClick={props.onSeeOdds}>view in stats</button>
            )}
            {says && (
              <button
                class="quiet"
                onClick={() => whatIf.onScenario(asItStands(league, whatIf.scenario))}
              >
                turn all off
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

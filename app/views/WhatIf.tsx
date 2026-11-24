/**
 * The what-if, said where its odds are: every trade in it on a row of
 * its own with a switch, the league's own still under review first and
 * the ones you built after, then the results and scoring you have set.
 *
 * The same panel sits on the stats tab and the trade tab, because the
 * two play out the same what-if. The stats tab shows the whole league
 * inside it; the trade tab weighs one more trade on top of it. A row is a
 * row rather than a chip because a trade needs its players said, and a
 * chip's tooltip is nothing on a phone.
 *
 * Switching a trade off keeps it listed, so a reader can compare with
 * and without it in two taps. Removing one of yours is its own button.
 * Nothing here is ever removed for the league's own: it goes when the
 * league processes it, and then it is in the rosters.
 */

import type { League } from "../lib/providers.ts";
import {
  isOn, movesOf, moveToDeal, teamsIn, toggled, whoGetsWhat,
  type Move, type PickMove, type Scenario, type Stale,
} from "../lib/scenario.ts";
import { ordinal } from "./Standings.tsx";

/** the what-if both tabs share, and what changes it */
export interface WhatIfState {
  scenario: Scenario;
  /** the league after the moves switched on, which went in, and which were left out */
  world: { league: League; applied: Move[]; stale: Stale[] };
  onScenario: (next: Scenario) => void;
}

/** a pick in a move, as a manager says it: "2027 1st", with whose it was where that matters */
const pickSays = (p: PickMove, me: string) =>
  `${p.season} ${ordinal(p.round)}` +
  (p.original !== p.giver ? ` (${p.original === me ? "yours" : p.original})` : "");

/** the teams in a move, you first and called you */
export const moveTitle = (move: Move, me: string) =>
  teamsIn(move, me).map((t) => (t === me ? "you" : t)).join(" ⇄ ");

/** what each team in a move comes away with, a clause each */
export function moveDetail(move: Move, me: string): string {
  return whoGetsWhat(move, me).map((t) => {
    const gets = [...t.players.map((p) => p.name), ...t.picks.map((p) => pickSays(p, me))];
    const who = t.owner === me ? "you" : t.owner;
    const said = gets.length ? `${who} ${t.owner === me ? "get" : "gets"} ${gets.join(", ")}` : "";
    const cut = t.cuts.length
      ? `${who} ${t.owner === me ? "drop" : "drops"} ${t.cuts.map((p) => p.name).join(", ")}`
      : "";

    return [said, cut].filter(Boolean).join(", ");
  }).join(" · ");
}

/** how the league says a move of its own stands, or that a move is yours */
const standing = (move: Move) =>
  move.by === "you" ? "yours" : move.status === "pending" ? "in review" : move.status ?? "pending";

export function WhatIfBar(props: {
  league: League;
  whatIf: WhatIfState;
  /** a trade of yours opened on the trade tab to change */
  onEdit?: ((move: Move) => void) | undefined;
  /** the one thing to do next from here: weigh a trade, or see the odds */
  action?: { says: string; onClick: () => void } | undefined;
  /** the move being changed on the trade tab, which says so on its row */
  editing?: string | null | undefined;
}) {
  const { league, whatIf } = props;
  const { scenario, world, onScenario } = whatIf;
  const me = league.team;
  const moves = movesOf(league, scenario);
  const settled = scenario.results.size > 0 || scenario.nudge !== 0;
  const stale = new Map(world.stale.map((s) => [s.move.id, s.missing]));
  const anyOn = world.applied.length > 0 || settled;

  if (!moves.length && !settled) {
    return null;
  }

  const counting = [
    world.applied.length
      ? `${world.applied.length} trade${world.applied.length === 1 ? "" : "s"}`
      : "",
    scenario.results.size
      ? `${scenario.results.size} result${scenario.results.size === 1 ? "" : "s"}`
      : "",
    scenario.nudge ? `you ${scenario.nudge > 0 ? "+" : "−"}${Math.round(Math.abs(scenario.nudge) * 100)}%` : "",
  ].filter(Boolean);
  // as things stand is every switch off and nothing picked, with the
  // trades still listed so any of them is a tap from back on
  const asItStands = (): Scenario => ({
    ...scenario,
    results: new Map(),
    nudge: 0,
    off: [...new Set([...scenario.off, ...moves.filter((m) => isOn(m, scenario)).map((m) => m.id)])],
    on: [],
  });

  return (
    <section class="whatif" aria-label="what if">
      <div class="wihead">
        <b>what if</b>
        <span>{counting.length ? `counting ${counting.join(" · ")}` : "nothing counted, as things stand"}</span>
        {anyOn && (
          <button class="textbtn" onClick={() => onScenario(asItStands())}>as it stands</button>
        )}
      </div>
      {moves.length > 0 && (
        <ul class="wimoves">
          {moves.map((move) => {
            const on = isOn(move, scenario);
            const left = on ? stale.get(move.id) : undefined;
            const editable = props.onEdit && moveToDeal(move, me) !== null;
            const title = moveTitle(move, me);

            return (
              <li key={move.id} class={on && !left ? "on" : "off"}>
                <button
                  class="wiswitch" role="switch" aria-checked={on}
                  aria-label={`count ${title}`}
                  onClick={() => onScenario(toggled(scenario, move))}
                />
                <div class="wibody">
                  <p class="witeams">
                    {title}
                    <span class={"wiby" + (move.by === "league" ? " league" : "")}>
                      {props.editing === move.id ? "changing" : standing(move)}
                    </span>
                  </p>
                  <p class="widetail">{moveDetail(move, me) || "nothing changes hands"}</p>
                  {left && <p class="wistale">left out: {left}</p>}
                </div>
                {move.by === "you" && (
                  <span class="wiacts">
                    {editable && (
                      <button class="textbtn" onClick={() => props.onEdit!(move)}>edit</button>
                    )}
                    <button
                      class="textbtn" aria-label={`remove ${title}`}
                      onClick={() => onScenario({
                        ...scenario,
                        moves: scenario.moves.filter((m) => m.id !== move.id),
                        off: scenario.off.filter((id) => id !== move.id),
                      })}
                    >
                      remove
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {settled && (
        <p class="wisettled">
          <span>
            {[
              scenario.results.size
                ? `${scenario.results.size} picked result${scenario.results.size === 1 ? "" : "s"}`
                : "",
              scenario.nudge
                ? `your scoring ${scenario.nudge > 0 ? "+" : "−"}${Math.round(Math.abs(scenario.nudge) * 100)}%`
                : "",
            ].filter(Boolean).join(" · ")}
          </span>
          <button
            class="textbtn"
            onClick={() => onScenario({ ...scenario, results: new Map(), nudge: 0 })}
          >
            reset
          </button>
        </p>
      )}
      {props.action && (
        <button class="textbtn wiaction" onClick={props.action.onClick}>{props.action.says}</button>
      )}
    </section>
  );
}

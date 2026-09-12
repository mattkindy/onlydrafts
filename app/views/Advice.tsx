/**
 * Your lineup against the best one you could put out.
 *
 * Both are drawn against the same opponent, so the gap between the two
 * is the lineup rather than the drawing. The matchup card and the start
 * view both show this, so it lives on its own.
 */

import { useMemo } from "preact/hooks";

import {
  bestLineupFor, standingFor, type GameState, type Lines,
} from "../lib/matchups.ts";
import type { Side } from "../lib/providers.ts";
import type { SlateRow } from "../lib/slate.ts";

export const pct = (share: number) => (100 * share).toFixed(0) + "%";

/** whatever anybody calls this man: the week, the board, or his key */
export const nameOf = (
  key: string, rows: Map<string, SlateRow>, lines: Lines,
) => rows.get(key)?.name ?? lines.get(key)?.name ?? key;

interface Props {
  side: Side;
  against: Side;
  slots: string[] | null;
  rows: Map<string, SlateRow>;
  states: Map<string, GameState>;
  lines: Lines;
  /** how often you win with the lineup you have, where the caller has it */
  odds?: number;
  /** what the remainder engine says a man in a live game still has to come */
  remainder?: Map<string, number[]> | null;
}

export function Advice(
  { side, against, slots, rows, states, lines, odds, remainder }: Props,
) {
  const played = remainder ?? undefined;
  const best = useMemo(
    () => bestLineupFor(
      side, against, slots, rows, states, undefined, lines, played),
    [side, against, slots, rows, states, lines, played],
  );
  const standing = useMemo(
    () => odds === undefined
      ? standingFor(
          { sides: [side, against] }, rows, states, lines, undefined, played,
        ).odds[0]
      : odds,
    [odds, side, against, rows, states, lines, played],
  );

  if (!best.swaps.length) {
    return (
      <div class="advice">
        <b>Lineup wins {pct(standing)}.</b> This is the best lineup you can set.
      </div>
    );
  }

  return (
    <div class="advice">
      <b>Lineup wins {pct(standing)}.</b> Best lineup {pct(best.odds)}.
      <ul>
        {best.swaps.map((swap) => (
          <li key={swap.starts + swap.benches}>
            Start {nameOf(swap.starts, rows, lines)} over{" "}
            {nameOf(swap.benches, rows, lines)} at {swap.slot}{" "}
            <span class="gain">(+{(100 * swap.gains).toFixed(1)}%)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

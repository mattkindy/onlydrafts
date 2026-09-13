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

/**
 * A share as a whole percentage, except at the ends. Rounded to 100% or
 * 0% a game that is nearly settled reads as over, and the tenth is what
 * says it is not.
 */
export function pct(share: number): string {
  const percent = 100 * share;

  if (percent === 0 || percent === 100 || (percent >= 1 && percent <= 99)) {
    return percent.toFixed(0) + "%";
  }

  // rounded toward the middle, so 99.97 says 99.9 and 0.04 says 0.1:
  // only a settled game prints as 100 or 0. The tenths are snapped first
  // because 0.001 * 1000 comes out a hair over 1 and ceiled to 0.2.
  const inTenths = Math.round(percent * 1e8) / 1e7;
  const tenths = percent > 99
    ? Math.floor(inTenths) / 10
    : Math.ceil(inTenths) / 10;

  return tenths.toFixed(1) + "%";
}

/**
 * A gain, in whole points of win probability. Every percentage on the
 * page is whole, so a swap worth a third of a point says so in words
 * rather than rounding away to nothing.
 */
export const gainPct = (share: number) =>
  100 * share < 0.5 ? "<1%" : "+" + pct(share);

/**
 * Whatever anybody calls this player: the week, the board, the provider, or
 * failing all three his key. The key is a name with its spaces taken out,
 * so falling straight to it printed "treysmack" on a kicker's row.
 */
export const nameOf = (
  key: string, rows: Map<string, SlateRow>, lines: Lines, said?: string,
) => rows.get(key)?.name ?? lines.get(key)?.name ?? said ?? key;

/** what the provider calls every player in a game, by the key a lineup uses */
export const namesIn = (sides: Side[]) => new Map(
  sides.flatMap((side) => [...side.starters, ...side.bench])
    .map((player) => [player.key, player.name] as const),
);

interface Props {
  side: Side;
  against: Side;
  slots: string[] | null;
  rows: Map<string, SlateRow>;
  states: Map<string, GameState>;
  lines: Lines;
  /** how often you win with the lineup you have, where the caller has it */
  odds?: number;
  /** what the remainder engine says a player in a live game still has to come */
  remainder?: Map<string, number[]> | null;
  /** opens a player's sheet, where the page has one to open */
  onMore?: (key: string) => void;
}

/**
 * A player's name where tapping it opens his sheet. Every name on the page
 * opens the same sheet, so they all have to look alike and none of them
 * can be a bare span some readers learn is dead.
 */
export function Who(
  { name, onOpen }: { name: string; onOpen?: (() => void) | undefined },
) {
  if (!onOpen) {
    return <>{name}</>;
  }

  return (
    <button
      class="who link"
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
    >
      {name}
    </button>
  );
}

export function Advice(
  { side, against, slots, rows, states, lines, odds, remainder, onMore }: Props,
) {
  const played = remainder ?? undefined;
  const said = useMemo(() => namesIn([side, against]), [side, against]);
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
        <b>Your lineup wins {pct(standing)}.</b> It is already the optimal
        lineup.
      </div>
    );
  }

  return (
    <div class="advice">
      <b>Your lineup wins {pct(standing)}.</b> Optimal lineup{" "}
      {pct(best.odds)}.
      <ul>
        {best.swaps.map((swap) => (
          <li key={swap.starts + swap.benches}>
            Start{" "}
            <Who
              name={nameOf(swap.starts, rows, lines, said.get(swap.starts))}
              onOpen={onMore ? () => onMore(swap.starts) : undefined}
            />{" "}
            over{" "}
            <Who
              name={nameOf(swap.benches, rows, lines, said.get(swap.benches))}
              onOpen={onMore ? () => onMore(swap.benches) : undefined}
            />{" "}
            at {swap.slot} <span class="gain">({gainPct(swap.gains)})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

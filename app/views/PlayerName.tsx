/**
 * A player's name in the space a phone has for it.
 *
 * About two fifths of a matchup row goes to each side, which is room for
 * roughly fourteen characters over two lines. A longer name drops its
 * first name to an initial rather than being cut off mid word, and his
 * team follows the name in brackets.
 */

import { initialForm } from "../lib/matchups.ts";

/** how many characters fit in a side of a row before the name shortens */
const FITS = 14;

export const fitted = (name: string) =>
  name.length > FITS ? initialForm(name) : name;

export function PlayerName(
  { name, team, stats, onOpen }: {
    name: string;
    team?: string | null;
    /** his box score so far, one line each for passing, rushing and receiving */
    stats?: string[] | undefined;
    /** opens his sheet, which every name on the page does */
    onOpen?: (() => void) | undefined;
  },
) {
  const said = <>{fitted(name)}{team && team !== name && <i> ({team})</i>}</>;

  return (
    <span class="playername" title={name}>
      {onOpen
        ? (
          <button
            class="link"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
          >
            {said}
          </button>
        )
        : <b>{said}</b>}
      {stats?.map((line) => <small class="line" key={line}>{line}</small>)}
    </span>
  );
}

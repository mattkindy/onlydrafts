/**
 * A player's name in the space a phone has for it.
 *
 * About two fifths of a matchup row goes to each side, which is room for
 * roughly fourteen characters over two lines. A longer name drops its
 * first name to an initial rather than being cut off mid word.
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
    /** his box score so far, once his game has kicked off */
    stats?: string | undefined;
    /** opens his sheet, which every name on the page does */
    onOpen?: (() => void) | undefined;
  },
) {
  return (
    <span class="playername" title={name}>
      {onOpen
        ? (
          <button
            class="link"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
          >
            {fitted(name)}
          </button>
        )
        : <b>{fitted(name)}</b>}
      {team && <i>{team}</i>}
      {stats && <small class="line">{stats}</small>}
    </span>
  );
}

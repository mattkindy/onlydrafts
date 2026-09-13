/**
 * A man's name in the space a phone has for it.
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

export function ManName(
  { name, team, onOpen }: {
    name: string;
    team?: string | null;
    /** opens his sheet, which every name on the page does */
    onOpen?: (() => void) | undefined;
  },
) {
  return (
    <span class="manname" title={name}>
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
    </span>
  );
}

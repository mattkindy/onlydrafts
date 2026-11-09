/**
 * Work still going on, said the same way everywhere.
 *
 * The board, the week and the scoreboard all take a moment, and each
 * page used to say so in its own words and its own style. A reader who
 * has seen one of them knows what this means on the next.
 */

import type { ComponentChildren } from "preact";

export function Reading({ children }: { children: ComponentChildren }) {
  return (
    <p class="loading">
      <span class="spin" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The shape of a page that has not arrived yet: a block where the
 * scoreline will be and a few where the cards will be.
 *
 * A line of grey text on an empty screen reads as a page that has
 * failed; the outline of the page says it is coming, and where. It is
 * hidden from a screen reader, which gets the words instead.
 */
export function Skeleton(
  { saying, cards = 3, lead = true }: {
    saying: string; cards?: number; lead?: boolean;
  },
) {
  return (
    <div class="skeleton" role="status">
      <span class="vh">{saying}</span>
      {lead && <div class="sk lead" aria-hidden="true" />}
      {Array.from({ length: cards }, (_, at) => (
        <div class="sk" key={at} aria-hidden="true" />
      ))}
    </div>
  );
}

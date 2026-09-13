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

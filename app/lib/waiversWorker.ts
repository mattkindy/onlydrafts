/**
 * The waiver page's season pricing, off the main thread.
 *
 * Two thousand weeks drawn for the whole board take long enough that
 * the page cannot paint, so the work happens here and the page gets
 * back the priced rows.
 *
 * The board stays here between asks. What a handful of adds cost turns
 * on what the reader has filtered to, and that changes without the
 * board changing at all.
 */

import {
  priceNets, priceSeason, type Kept, type WaiversAnswer, type WaiversAsk,
} from "./waiversSeason.ts";
import { notePassCatchers } from "./winShare.ts";

let kept: Kept | null = null;

export function answer(ask: WaiversAsk): WaiversAnswer {
  if (ask.ask === "nets") {
    // nobody should ask before the season, but the page must not hang
    return kept ? priceNets(kept, ask) : { said: "nets", nets: [] };
  }

  const schedule = ask.schedule;
  notePassCatchers(
    ask.men,
    schedule ? (team, week) => schedule[team]?.[week - 1] ?? null : null,
  );
  const said = priceSeason(ask);
  kept = said.kept;

  return said.answer;
}

self.onmessage = (event: MessageEvent<WaiversAsk>) => {
  self.postMessage(answer(event.data));
};

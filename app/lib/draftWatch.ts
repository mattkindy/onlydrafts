/**
 * The draft as it stands right now.
 *
 * Sleeper answers with the picks made so far; ESPN keeps its draft
 * behind a view we cannot reach, so a league there is watched by hand
 * through the marks and the typed names.
 */

import { normalizeName, keep } from "./store.ts";
import { providerOf, type League } from "./providers.ts";
import type { DraftNow, Pick } from "../views/Draft.tsx";

/**
 * How many picks are still to be made before yours. A keeper draft
 * starts with slots already filled all over the board, so both your
 * next turn and the count skip anything already taken.
 */
function picksUntil(
  mySlot: number, overall: number, teams: number, rounds: number,
  filled: Set<number>,
) {
  let toCome = 0;

  for (let n = overall; n <= teams * rounds; n++) {
    if (filled.has(n)) {
      continue;
    }

    const round = Math.ceil(n / teams);
    const inRound = n - (round - 1) * teams;
    const slot = round % 2 === 1 ? inRound : teams - inRound + 1;

    if (slot === mySlot) {
      return toCome;
    }

    toCome++;
  }

  return null;
}

interface Options {
  league: League | null;
  marked: Record<string, string>;
  /** extra names typed in as taken, one per line */
  manual: string;
  nameFor: (key: string) => string;
  positionFor: (key: string) => string;
}

export async function draftNow(options: Options): Promise<DraftNow> {
  const { league, marked, manual } = options;
  const state: DraftNow = {
    taken: new Set(Object.keys(marked)),
    mine: new Set(),
    teams: {},
    rosteredBy: {},
    grid: null,
    made: [],
  };

  for (const line of manual.split("\n")) {
    if (line.trim()) {
      state.taken.add(normalizeName(line));
    }
  }

  for (const [key, owner] of Object.entries(marked)) {
    state.teams[key] = owner + " (keeper)";

    if (league && owner === league.team) {
      state.mine.add(key);
    }
  }

  // who each player sat with last season, shown as a note only; nobody
  // leaves the board without an actual keeper pick or a typed name
  for (const roster of league?.allRosters ?? []) {
    for (const k of roster.keys) {
      state.rosteredBy[k.key] = roster.owner;
    }
  }

  const watching = league ? providerOf(league).draftNow : null;
  const now = league && watching ? await watching(league) : null;

  if (!now || !league) {
    return state;
  }

  const { draft, picks } = now;

  const made: Pick[] = [];

  for (const pick of picks as (typeof picks[number] & {
    round: number; draft_slot: number; metadata?: { position?: string };
  })[]) {
    const name = options.nameFor(pick.player_id);

    if (!name) {
      continue;
    }

    const key = normalizeName(name);
    const mine = pick.picked_by === league.userId;
    const who = mine
      ? league.team
      : league.members[pick.picked_by] ?? "slot " + pick.draft_slot;
    state.taken.add(key);
    state.teams[key] = who;

    if (mine) {
      state.mine.add(key);
    }

    made.push({
      overall: pick.pick_no,
      round: pick.round,
      slot: pick.draft_slot,
      name,
      position: pick.metadata?.position ?? options.positionFor(pick.player_id),
      who,
      mine,
      keeper: Boolean(pick.is_keeper),
    });
  }

  state.made = made.sort((a, b) => a.overall - b.overall);

  const teams = draft.settings?.teams ?? league.size ?? 12;
  const rounds = draft.settings?.rounds ?? 15;
  const mySlot = draft.draft_order?.[league.userId] ?? null;
  const cells: Record<string, string> = {};

  for (const pick of picks as (typeof picks[number] & {
    round: number; draft_slot: number;
  })[]) {
    const name = options.nameFor(pick.player_id);
    cells[pick.round + "|" + pick.draft_slot] =
      name ? name.split(" ").at(-1)! : "?";
  }

  state.grid = { rounds, teams, mySlot, cells };
  state.pickCount = picks.length;
  state.status = draft.status;

  /**
   * The next pick is the first empty slot, not one past the count.
   * Keepers land all over the board before anyone drafts, so counting
   * picks said the draft was thirty picks in while everyone waited on
   * pick one.
   */
  const filled = new Set(picks.map((p) => p.pick_no));
  let overall = 1;

  while (filled.has(overall)) {
    overall++;
  }

  state.filled = [...filled];
  const round = Math.ceil(overall / teams);
  const inRound = overall - (round - 1) * teams;
  const slot = round % 2 === 1 ? inRound : teams - inRound + 1;
  const userAt: Record<number, string> = {};

  for (const [userId, s] of Object.entries(draft.draft_order ?? {})) {
    userAt[s] = userId;
  }

  state.clock = {
    overall,
    who: league.members[userAt[slot] ?? ""] ?? "slot " + slot,
    mine: mySlot === slot,
    untilMine: mySlot ? picksUntil(mySlot, overall, teams, rounds, filled) : null,
  };

  keep("draftState", {
    ...state,
    taken: [...state.taken],
    mine: [...state.mine],
    at: new Date().toISOString().slice(0, 16).replace("T", " "),
  });

  return state;
}

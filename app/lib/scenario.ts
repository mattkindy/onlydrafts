/**
 * A what-if: the league as it stands with some things changed, played
 * out by the same simulation the stats tab and the trade tab both use.
 *
 * Three kinds of change go into one. Roster moves: a trade the league has
 * agreed and not yet processed, or one built on the trade tab and kept.
 * Results: a game somebody has said who wins. And your own scoring
 * against its projection. The stats tab shows the whole league inside
 * the what-if; the trade tab weighs one more trade on top of it, so a
 * trade is judged in the league it would land in, with the trade still
 * under review counted, rather than in last week's.
 *
 * Moves are applied in order, each to the rosters the one before left,
 * and a move whose players have since gone elsewhere is set aside and
 * says why rather than moving somebody who is not there.
 */

import type { DraftPick, League, RosterPlayer } from "./providers.ts";
import { pairKey, type Strength } from "./seasonStats.ts";
import { pickId, type Deal } from "./trade.ts";
import { keep, stored } from "./store.ts";

/** one player changing hands: from a team, or off waivers where `from` is null; to a team, or cut */
export interface PlayerMove extends RosterPlayer {
  from: string | null;
  to: string | null;
}

/** one draft pick changing hands, by `pickId`, from the team holding it */
export interface PickMove {
  id: string;
  season: number;
  round: number;
  /** whose pick it was to begin with */
  original: string;
  giver: string;
  to: string;
}

export interface Move {
  /** "league:<the provider's id>" for one the league reports, "you:<n>" for one built here */
  id: string;
  by: "league" | "you";
  /** how it stands with the league, in the provider's word: pending, for one under review */
  status?: string;
  /** when it was made, for the order the league's own are listed in */
  at?: number;
  players: PlayerMove[];
  picks: PickMove[];
}

/** the parts of a what-if the reader sets */
export interface Scenario {
  /** trades built here and kept, in the order they were added */
  moves: Move[];
  /** the moves switched off, the league's and yours, by id */
  off: string[];
  /** the league's own moves switched on that start off, by id */
  on: string[];
  /** results picked, by `pairKey` of the season's own week number, each naming the winner or TIE */
  results: Map<string, string>;
  /** your scoring against its projection, as a share: 0.1 is ten percent over */
  nudge: number;
}

export const NO_SCENARIO: Scenario = { moves: [], off: [], on: [], results: new Map(), nudge: 0 };

/**
 * Whether the league's own move counts until the reader says otherwise.
 * A trade both managers accepted that waits out a review almost always
 * goes through, so it counts; anything the provider calls by some other
 * word is listed and left off, since what it means is not known here.
 */
export const countsAtFirst = (move: Move) => move.by === "league" && move.status === "pending";

export function isOn(move: Move, scenario: Scenario): boolean {
  if (scenario.off.includes(move.id)) {
    return false;
  }

  return move.by === "you" || countsAtFirst(move) || scenario.on.includes(move.id);
}

/** every move in the what-if, the league's first in the order made, then yours as added */
export function movesOf(league: Pick<League, "pending">, scenario: Scenario): Move[] {
  const theirs = [...(league.pending ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  return [...theirs, ...scenario.moves];
}

export interface Stale {
  move: Move;
  /** who is missing and from where, for the line that says it was left out */
  missing: string;
}

type Team = { owner: string; keys: RosterPlayer[] };

/**
 * The rosters and picks after the moves, each applied to what the one
 * before left. A move is all or nothing: if any player in it is no longer
 * where it says he comes from, or any pick is held by somebody else now,
 * none of it happens and it is listed as stale. A pick the league does not
 * list at all is let through, since there is nothing to check it against.
 */
export function applyMoves<T extends Team>(
  rosters: T[], picks: DraftPick[], moves: Move[],
): { rosters: T[]; picks: DraftPick[]; applied: Move[]; stale: Stale[] } {
  let now = rosters;
  let held = picks;
  const applied: Move[] = [];
  const stale: Stale[] = [];

  for (const move of moves) {
    const teamOf = (owner: string) => now.find((r) => r.owner === owner);
    const rostered = new Set(now.flatMap((r) => r.keys.map((p) => p.key)));
    const gone = move.players.find((p) => p.from === null
      ? rostered.has(p.key)
      : !teamOf(p.from)?.keys.some((k) => k.key === p.key));
    const noTeam = move.players.find((p) => p.to !== null && !teamOf(p.to));
    // a pick the league does not list, in a league that does not trade
    // them, cannot be checked and changes nothing this season, so it
    // stands aside rather than holding the players up
    const pickGone = move.picks.find((m) => {
      const pick = held.find((h) => pickId(h) === m.id);

      return pick !== undefined && pick.owner !== m.giver;
    });

    if (gone || noTeam || pickGone) {
      stale.push({
        move,
        missing: gone
          ? gone.from === null
            ? `${gone.name} is already on a roster`
            : `${gone.name} isn't on ${gone.from}'s roster anymore`
          : noTeam
            ? `${noTeam.to} isn't in the league`
            : `${pickGone!.giver} doesn't have that ${pickGone!.season} round ${pickGone!.round} pick`,
      });
      continue;
    }

    const leaving = new Map(move.players.filter((p) => p.from !== null).map((p) => [p.key, p.from]));

    now = now.map((r) => {
      const kept = r.keys.filter((p) => leaving.get(p.key) !== r.owner);
      const arriving = move.players.filter((p) => p.to === r.owner)
        .map(({ from: _from, to: _to, ...player }) => {
          // the roster's own entry where it has one, which the board matched
          const was = now.find((t) => t.owner === _from)?.keys.find((k) => k.key === player.key);

          return was ?? player;
        });

      return kept.length === r.keys.length && !arriving.length
        ? r
        : { ...r, keys: [...kept, ...arriving] };
    });
    held = held.map((h) => {
      const moved = move.picks.find((m) => m.id === pickId(h));

      return moved ? { ...h, owner: moved.to } : h;
    });
    applied.push(move);
  }

  return { rosters: now, picks: held, applied, stale };
}

/**
 * The league inside the what-if: its rosters and picks after the moves
 * switched on. Everything else is the league's own, so a page reading it
 * asks the same provider about the same weeks.
 */
export function scenarioLeague(league: League, scenario: Scenario): {
  league: League; applied: Move[]; stale: Stale[];
} {
  const moves = movesOf(league, scenario).filter((m) => isOn(m, scenario));

  if (!moves.length) {
    return { league, applied: [], stale: [] };
  }

  const after = applyMoves(league.allRosters, league.picks ?? [], moves);

  if (!after.applied.length) {
    return { league, applied: [], stale: after.stale };
  }

  const mine = after.rosters.find((r) => r.owner === league.team);

  return {
    league: {
      ...league,
      allRosters: after.rosters,
      ...(mine ? { myRoster: mine.keys } : {}),
      ...(league.picks ? { picks: after.picks } : {}),
    },
    applied: after.applied,
    stale: after.stale,
  };
}

/** a trade built on the trade tab as a move: what you send goes to them, what you get comes to you */
export function dealToMove(
  deal: Deal, league: Pick<League, "team" | "allRosters" | "picks">, id: string,
): Move {
  const me = league.team;
  const rosterOf = (owner: string) =>
    league.allRosters.find((r) => r.owner === owner)?.keys ?? [];
  const players = (keys: string[], from: string, to: string): PlayerMove[] => keys.flatMap((key) => {
    const p = rosterOf(from).find((k) => k.key === key);

    return p ? [{ ...p, from, to }] : [];
  });
  const picks = (ids: string[], giver: string, to: string): PickMove[] => ids.flatMap((pid) => {
    const p = (league.picks ?? []).find((h) => pickId(h) === pid);

    return p ? [{ id: pid, season: p.season, round: p.round, original: p.from, giver, to }] : [];
  });

  return {
    id,
    by: "you",
    players: [...players(deal.give, me, deal.partner), ...players(deal.get, deal.partner, me)],
    picks: [...picks(deal.givePicks, me, deal.partner), ...picks(deal.getPicks, deal.partner, me)],
  };
}

/**
 * A move of yours back as a deal to change, where it is a trade between
 * you and one other team; nothing for any other shape.
 */
export function moveToDeal(move: Move, me: string): Deal | null {
  const teams = teamsIn(move);

  if (move.by !== "you" || teams.length !== 2 || !teams.includes(me)) {
    return null;
  }

  const partner = teams.find((t) => t !== me)!;

  return {
    partner,
    give: move.players.filter((p) => p.from === me).map((p) => p.key),
    get: move.players.filter((p) => p.to === me).map((p) => p.key),
    givePicks: move.picks.filter((p) => p.giver === me).map((p) => p.id),
    getPicks: move.picks.filter((p) => p.to === me).map((p) => p.id),
  };
}

/** the teams a move touches, yours first where it is one of them */
export function teamsIn(move: Move, me?: string): string[] {
  const all = [...new Set([
    ...move.players.flatMap((p) => [p.from, p.to]),
    ...move.picks.flatMap((p) => [p.giver, p.to]),
  ].filter((t): t is string => t !== null))];

  return me && all.includes(me) ? [me, ...all.filter((t) => t !== me)] : all;
}

/** what each team in a move comes away with, and who it cuts */
export function whoGetsWhat(move: Move, me?: string): {
  owner: string; players: PlayerMove[]; picks: PickMove[]; cuts: PlayerMove[];
}[] {
  return teamsIn(move, me).map((owner) => ({
    owner,
    players: move.players.filter((p) => p.to === owner),
    picks: move.picks.filter((p) => p.to === owner),
    cuts: move.players.filter((p) => p.from === owner && p.to === null),
  })).filter((t) => t.players.length || t.picks.length || t.cuts.length);
}

/** whether a what-if changes anything, and so whether a page should say it is one */
export function scenarioCounts(scenario: Scenario, applied: Move[]) {
  return {
    moves: applied.length,
    results: scenario.results.size,
    nudge: scenario.nudge,
    any: applied.length > 0 || scenario.results.size > 0 || scenario.nudge !== 0,
  };
}

/**
 * Results picked by the season's week number, as the simulation wants
 * them: by each week's place from the coming one, the weeks already
 * played left out.
 */
export function resultsFrom(results: Map<string, string>, coming: number): Map<string, string> {
  const out = new Map<string, string>();

  for (const [key, winner] of results) {
    const [week, pair] = splitKey(key);

    if (week >= coming) {
      out.set(`${week - coming}:${pair}`, winner);
    }
  }

  return out;
}

/** a pick made against a week's place from the coming one, kept by the season's week */
export const resultKey = (place: number, coming: number, a: string, b: string) =>
  pairKey(place + coming, a, b);

function splitKey(key: string): [number, string] {
  const at = key.indexOf(":");

  return [Number(key.slice(0, at)), key.slice(at + 1)];
}

/** your team's strengths scaled by how you think it will score, everybody else's left alone */
export function nudged(
  strengths: Map<string, Strength>, team: string, nudge: number,
): Map<string, Strength> {
  const mine = strengths.get(team);

  if (!nudge || !mine) {
    return strengths;
  }

  const out = new Map(strengths);

  out.set(team, { ...mine, mean: mine.mean * (1 + nudge) });

  return out;
}

/**
 * What a what-if keeps between visits: the trades you built and which
 * moves are switched on. Results and the scoring nudge last the session,
 * as they always have, since a pick is a question asked now and a trade
 * being weighed is one carried for days.
 */
interface Kept {
  moves: Move[];
  off: string[];
  on: string[];
}

export const scenarioKey = (league: Pick<League, "provider" | "leagueId">) =>
  `scenario:${league.provider}:${league.leagueId}`;

export function readScenario(league: Pick<League, "provider" | "leagueId">): Scenario {
  const kept = stored<Partial<Kept> | null>(scenarioKey(league), null);

  return {
    moves: Array.isArray(kept?.moves) ? kept.moves : [],
    off: Array.isArray(kept?.off) ? kept.off : [],
    on: Array.isArray(kept?.on) ? kept.on : [],
    results: new Map(),
    nudge: 0,
  };
}

/**
 * Keeps the lasting parts, forgetting a switch for a move that no longer
 * exists: a league trade that has gone through is in the rosters now, and
 * one of yours that was removed has nothing to switch.
 */
export function keepScenario(
  league: Pick<League, "provider" | "leagueId" | "pending">, scenario: Scenario,
): void {
  const ids = new Set(movesOf(league, scenario).map((m) => m.id));

  keep(scenarioKey(league), {
    moves: scenario.moves,
    off: scenario.off.filter((id) => ids.has(id)),
    on: scenario.on.filter((id) => ids.has(id)),
  } satisfies Kept);
}

/** a move switched the other way */
export function toggled(scenario: Scenario, move: Move): Scenario {
  const on = isOn(move, scenario);
  const without = (ids: string[]) => ids.filter((id) => id !== move.id);
  const startsOn = move.by === "you" || countsAtFirst(move);

  return on
    ? { ...scenario, off: [...without(scenario.off), move.id], on: without(scenario.on) }
    : {
        ...scenario,
        off: without(scenario.off),
        on: startsOn ? without(scenario.on) : [...without(scenario.on), move.id],
      };
}

/**
 * What a trade is worth to each side.
 *
 * Two questions, kept apart because they answer different managers. Now:
 * what it does to each team's best weekly lineup and so to its chance of
 * making the playoffs, which is what a contender is buying. Later: the
 * draft picks that change hands, worth what a pick at that place in the
 * draft is worth, which is what a rebuilding team is buying.
 *
 * A player is valued for the rest of this season only: the points he
 * scores over a replacement, for the games he is expected to play from
 * here. What he is worth in seasons to come needs his age, which the
 * board does not carry yet, so a dynasty league reads the players as a
 * one season rental and says so.
 */

import type { DraftPick, League, RosterPlayer } from "./providers.ts";
import type { Player } from "./scoring.ts";

/** a trade as two lists a side: players by key, picks by `pickId` */
export interface Deal {
  partner: string;
  give: string[];
  get: string[];
  givePicks: string[];
  getPicks: string[];
}

export const NO_DEAL = (partner: string): Deal =>
  ({ partner, give: [], get: [], givePicks: [], getPicks: [] });

export const pickId = (p: Pick<DraftPick, "season" | "round" | "from">) =>
  `${p.season}:${p.round}:${p.from}`;

export const dealIsEmpty = (deal: Deal) =>
  !deal.give.length && !deal.get.length && !deal.givePicks.length && !deal.getPicks.length;

/**
 * What a pick a season further off is worth against one in the coming
 * draft. Not fitted: a pick a year out is a year of waiting and a draft
 * class nobody has seen, and a quarter less a year is the usual rule of
 * thumb among people who trade them. Said here so it can be argued with.
 */
export const SEASON_OUT = 0.8;

/** how a points-over-replacement figure reads on the page */
export const valueSays = (points: number) => Math.round(points).toString();

/**
 * His points over a replacement for the rest of the season: what he beats
 * the last starter by in a game, for the games he is expected to play from
 * the coming week, injury report included. A player below replacement is
 * worth nothing rather than less than nothing, since he can be cut.
 */
export function restOfSeason(p: Player | undefined, weeksLeft: number): number {
  if (!p) {
    return 0;
  }

  const perGame = Math.max(0, p.perGameVor ?? 0);
  const games = p.weeksLeft
    ? p.weeksLeft.plays.slice(0, Math.max(0, weeksLeft)).reduce((a, b) => a + b, 0)
    : ((p.games ?? 0) / 17) * Math.max(0, weeksLeft);

  return perGame * games;
}

/**
 * What a pick at each place in a draft is worth, in points over a
 * replacement across a season: what the board says a player taken there
 * is worth, smoothed over the picks either side, since one room's order
 * is noisier than the shape of the curve.
 */
export function draftCurve(players: Player[]): (overall: number) => number {
  const order = players
    .filter((p) => p.adpRank && p.vor !== undefined)
    .sort((a, b) => a.adpRank! - b.adpRank!)
    .map((p) => Math.max(0, p.vor!));

  return (overall: number) => {
    if (!order.length) {
      return 0;
    }

    const at = Math.min(order.length - 1, Math.max(0, Math.round(overall) - 1));
    const near = order.slice(Math.max(0, at - 2), at + 3);

    return near.reduce((a, b) => a + b, 0) / near.length;
  };
}

/** the overall pick a slot in a round is, snaking where the draft does */
export const overallPick = (round: number, slot: number, teams: number, snake: boolean) =>
  (round - 1) * teams + (snake && round % 2 === 0 ? teams + 1 - slot : slot);

/**
 * Where a pick falls in its round: the worst team picks first, so the
 * slot is the team's place from the bottom on its projected finish. A
 * pick in a season further off, or from a team nobody has a finish for,
 * could fall anywhere and is priced at every slot alike.
 */
export function pickValue(
  pick: DraftPick,
  input: {
    curve: (overall: number) => number;
    teams: number;
    snake: boolean;
    /** the season the trade is made in */
    season: number;
    /** each team's place in the coming draft, 1 picking first */
    slotOf: (owner: string) => number | null;
  },
): number {
  const { curve, teams, snake } = input;
  const out = Math.max(0, pick.season - input.season);
  const slot = out <= 1 ? input.slotOf(pick.from) : null;
  const atSlot = (s: number) => curve(overallPick(pick.round, s, teams, snake));
  const worth = slot
    ? atSlot(slot)
    : Array.from({ length: teams }, (_, i) => atSlot(i + 1)).reduce((a, b) => a + b, 0) / teams;

  return worth * SEASON_OUT ** Math.max(0, out - 1);
}

/**
 * The draft order a season's finish gives: the team expected to win
 * fewest picks first. Ties go by name, so the order never flickers.
 */
export function slotsFromWins(wins: { owner: string; wins: number }[]): Map<string, number> {
  return new Map([...wins]
    .sort((a, b) => a.wins - b.wins || a.owner.localeCompare(b.owner))
    .map((t, i) => [t.owner, i + 1]));
}

/** every roster as it would be after the deal; the two sides swap what they send */
export function rostersAfter(
  league: League, deal: Deal, mine = league.team,
): { owner: string; keys: RosterPlayer[] }[] {
  const all = league.allRosters;
  const find = (owner: string) => all.find((r) => r.owner === owner)?.keys ?? [];
  const sent = (owner: string, keys: string[]) =>
    find(owner).filter((p) => keys.includes(p.key));
  const ours = sent(mine, deal.give);
  const theirs = sent(deal.partner, deal.get);

  return all.map((r) => {
    if (r.owner === mine) {
      return { owner: r.owner, keys: [...r.keys.filter((p) => !deal.give.includes(p.key)), ...theirs] };
    }

    if (r.owner === deal.partner) {
      return { owner: r.owner, keys: [...r.keys.filter((p) => !deal.get.includes(p.key)), ...ours] };
    }

    return { owner: r.owner, keys: r.keys };
  });
}

/**
 * How many players a side has to let go to stay inside the roster: every
 * slot on it bar injured reserve, which holds players the count leaves out.
 */
export function overTheLimit(league: League, deal: Deal, side: "mine" | "theirs"): number {
  const room = (league.slots ?? []).filter((s) => s !== "IR").length;

  if (!room) {
    return 0;
  }

  const owner = side === "mine" ? league.team : deal.partner;
  const now = league.allRosters.find((r) => r.owner === owner)?.keys.length ?? 0;
  const delta = side === "mine"
    ? deal.get.length - deal.give.length
    : deal.give.length - deal.get.length;

  // a roster can stand over the count already, with somebody on reserve
  // the provider still lists, so only what the deal adds is asked of it
  return Math.max(0, now + delta - room) - Math.max(0, now - room);
}

/**
 * Where a team stands, by its chance of making the playoffs as things
 * are: in it, on the bubble, a long shot, or out of it. The lines are
 * round numbers, not fitted; they decide only how the verdict reads.
 */
export type Stage = "contender" | "bubble" | "long shot" | "out of it";

export const stageOf = (playoffs: number): Stage =>
  playoffs >= 0.75 ? "contender" : playoffs >= 0.25 ? "bubble" : playoffs >= 0.05 ? "long shot" : "out of it";

export interface Verdict {
  says: string;
  tone: "up" | "down" | "flat";
}

/**
 * The trade in a few words, for you. `now` and `theirs` are what it does
 * to each side's season, in rounded points of chance, so anything under
 * a point is the dice and reads as nothing. `later` is the picks, in
 * points over a replacement, yours less theirs.
 *
 * Where the season and the picks pull opposite ways it is a choice
 * between now and later, and where you stand makes it: a contender is
 * buying a title and a team out of the race is buying next year, so
 * the same trade is right for one and wrong for the other.
 */
export function tradeVerdict(input: {
  now: number;
  theirs: number;
  later: number;
  stage: Stage | null;
}): Verdict {
  const { now: a, theirs: b, later, stage } = input;

  if (a > 0 && later < -0.5) {
    return stage === "contender"
      ? { says: "buys a title shot with later", tone: "up" }
      : stage === "bubble" || stage === null
        ? { says: "wins now, costs later", tone: "flat" }
        : { says: "costs later for a long shot", tone: "down" };
  }

  if (a < 0 && later > 0.5) {
    return stage === "contender"
      ? { says: "costs your title shot for later", tone: "down" }
      : stage === "bubble" || stage === null
        ? { says: "costs now, pays later", tone: "flat" }
        : { says: "sells a lost season for later", tone: "up" };
  }

  if (a > 0 && b >= 0) {
    return { says: "helps you both", tone: "up" };
  }

  if (a > 0) {
    return { says: "better for you", tone: "up" };
  }

  if (a < 0 && b > 0) {
    return { says: "better for them", tone: "down" };
  }

  if (a < 0) {
    return { says: "costs you", tone: "down" };
  }

  return later > 0.5
    ? { says: "even now, pays later", tone: "flat" }
    : later < -0.5
      ? { says: "even now, costs later", tone: "flat" }
      : { says: "about even", tone: "flat" };
}

/**
 * What a pick is likely to buy, and what a man is worth against it.
 *
 * Everything here takes the board and the draft it is being read
 * against, so the same functions serve the draft board and the keeper
 * sheet. The draft never enters as a global.
 */

import type { Player } from "./scoring.ts";

export interface Draft {
  teams: number;
  /** which seat is yours, when you know */
  slot?: number | null;
  snake: boolean;
  /** the rounds you still hold, when the league says */
  myRounds?: number[] | null;
  /** everyone already off the board */
  taken: Set<string>;
}

/** a season's worth of points where keeping and drafting are level */
export const CLOSE_SEASON = 8;

/** pick 44 in a 12-team draft is how everyone says it: 4.08 */
export function asRound(pick: number, teams: number): string {
  const overall = Math.max(1, Math.round(pick));
  const round = Math.ceil(overall / teams);

  return round + "." + String(overall - (round - 1) * teams).padStart(2, "0");
}

export function pickForRound(round: number, draft: Draft): number {
  const { teams, slot, snake } = draft;

  if (!slot) {
    return (round - 1) * teams + Math.ceil(teams / 2);
  }

  const inRound = snake && round % 2 === 0 ? teams - slot + 1 : slot;

  return (round - 1) * teams + inRound;
}

/**
 * How often he is still on the board at a pick, from his own draft
 * position and how far it swings either way.
 */
export function stillThereAt(o: Player, pick: number): number {
  if (!o.adp) {
    return 0;
  }

  const early = o.adpHigh ?? o.adp;
  const late = o.adpLow ?? o.adp;

  if (pick <= early) {
    return 1;
  }

  /**
   * Past the latest anyone has taken him, one draft in ten still lets
   * him slide. Rooms differ and the range comes from other people's
   * drafts, so nobody is ever certain to be gone.
   */
  if (pick >= late) {
    return 0.1;
  }

  return 1 - (pick - early) / Math.max(1, late - early);
}

export interface Chance { who: Player; odds: number }

/**
 * What the pick buys, weighing every candidate by the chance he is the
 * one you end up taking: he lasts, and everyone better has gone.
 */
export function expectedBestAt(
  men: Player[],
  pick: number,
  draft: Draft,
  exclude: string | null,
  position: string | null,
  showing?: Chance[],
): number {
  const candidates = men
    .filter((o) => o.key !== exclude && !draft.taken.has(o.key) && o.adp &&
      o.adp >= pick - 12 && (!position || o.position === position))
    .sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0))
    .slice(0, 40);
  let stillGone = 1;
  let worth = 0;

  for (const o of candidates) {
    const there = stillThereAt(o, pick);
    const takesHim = there * stillGone;
    worth += (o.vor ?? 0) * takesHim;

    if (showing && takesHim > 0.02) {
      showing.push({ who: o, odds: takesHim });
    }

    stillGone *= 1 - there;

    if (stillGone < 0.01) {
      break;
    }
  }

  // and the tail, where every one of them has gone
  return worth + (candidates[candidates.length - 1]?.vor ?? 0) * stillGone;
}

/**
 * Anyone the room takes near this pick and might last to it, best
 * first by what we think they are worth. The window opens a little
 * before the pick, since draft position is an average and the men who
 * go a touch earlier are sometimes still sitting there.
 */
export function optionsAt(
  men: Player[],
  pick: number,
  draft: Draft,
  exclude: string | null,
  position: string | null,
  howMany = 4,
): Player[] {
  const near = (p: Player) =>
    p.key !== exclude && !draft.taken.has(p.key) && p.adp &&
    p.adp >= pick - 6 && p.adp <= pick + 24 &&
    (!position || p.position === position);
  const found = men.filter(near);

  // the window widens rather than coming back empty, since late in a
  // draft a position can have nobody at all inside twenty picks
  const wider = found.length >= 2
    ? found
    : men.filter((p) =>
        p.key !== exclude && !draft.taken.has(p.key) && p.adp &&
        p.adp >= pick - 12 && (!position || p.position === position));

  return wider
    .sort((a, b) => (b.perGameVor ?? 0) - (a.perGameVor ?? 0))
    .slice(0, howMany);
}

export function bestLeftAt(
  men: Player[],
  pick: number,
  draft: Draft,
  exclude: string | null,
  position: string | null,
  byRanking: boolean,
): Player | null {
  const free = men.filter((p) =>
    p.key !== exclude && !draft.taken.has(p.key) &&
    (!position || p.position === position));

  if (byRanking) {
    // Our own order instead of the market's. Where the two disagree the
    // room is the one setting the price, so this is a second opinion.
    const ours = men.filter((p) => !draft.taken.has(p.key))
      .sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0));
    const reachable = new Set(ours.slice(pick - 1).map((p) => p.key));
    const left = free.filter((p) => reachable.has(p.key));

    return left.length
      ? left.reduce((best, p) => ((p.vor ?? 0) > (best.vor ?? 0) ? p : best))
      : null;
  }

  // Anyone the market expects to last this long, ordered by the blend.
  // On its own the model had J.K. Dobbins as the best man at pick 30 on
  // a draft position of 96.
  const left = free
    .filter((p) => p.adp && p.adp >= pick)
    .sort((a, b) => (a.blend ?? a.adp!) - (b.blend ?? b.adp!))
    .slice(0, 12);

  return left.length
    ? left.reduce((best, p) => ((p.vor ?? 0) > (best.vor ?? 0) ? p : best))
    : null;
}

export interface Wait {
  chance: number;
  gain: number;
  atPick: number | null;
  round?: number;
}

/**
 * What letting him go is worth: the chance he is still there at your
 * first realistic pick, times his surplus over what that pick buys.
 */
export function redraftWorth(men: Player[], player: Player, draft: Draft): Wait {
  if (!player.adp) {
    return { chance: 0, gain: 0, atPick: null };
  }

  const early = player.adpHigh || player.adp;
  const late = player.adpLow || player.adp;

  for (let round = 1; round <= 16; round++) {
    // only the picks still yours: a traded round cannot draft anybody
    if (draft.myRounds && !draft.myRounds.includes(round)) {
      continue;
    }

    const pick = pickForRound(round, draft);

    if (pick < early - 2) {
      continue;
    }

    const chance = pick <= early ? 1
      : pick >= late ? 0.05
      : 1 - (pick - early) / Math.max(1, late - early);
    const rate = expectedBestAt(men, pick, draft, player.key, player.position);
    const gain = Math.max(0, (player.vor ?? 0) - rate);

    return { chance, gain: chance * gain, atPick: pick, round };
  }

  return { chance: 0, gain: 0, atPick: null };
}

/**
 * The earliest round where keeping him still beats using the pick.
 *
 * Measured over a season, the same way the card is. Comparing a per
 * game margin against a season's threshold is a test nothing can fail,
 * which is how every man came out worth a first or a second.
 */
export function worthUpTo(men: Player[], player: Player, draft: Draft) {
  for (let round = 1; round <= 15; round++) {
    const pick = pickForRound(round, draft);
    const margin = (player.vor ?? 0) -
      expectedBestAt(men, pick, draft, player.key, player.position);

    if (margin > -CLOSE_SEASON) {
      return {
        round,
        margin,
        instead: bestLeftAt(men, pick, draft, player.key, null, false),
        thin: false,
      };
    }
  }

  return { round: 16, instead: null, margin: 0, thin: true };
}

/** the keep as one sum, which both the chip and the figures read */
export function keeperSums(
  men: Player[],
  p: Player,
  costPick: number,
  draft: Draft,
) {
  /**
   * What the pick buys at his own position, which is the swap you are
   * actually making: keeping a back means drafting one fewer back.
   */
  const makesItUp: Chance[] = [];
  const best = bestLeftAt(men, costPick, draft, p.key, p.position, false);
  const rate = expectedBestAt(men, costPick, draft, p.key, p.position, makesItUp);
  const roi = (p.vor ?? 0) - rate;
  const wait = redraftWorth(men, p, draft);

  return {
    best,
    rate,
    roi,
    wait,
    net: roi - wait.gain,
    makesItUp: makesItUp.sort((a, b) => b.odds - a.odds).slice(0, 4),
  };
}

/**
 * His good week against the man who would start at his position
 * anyway. Comparing raw ceilings across positions had a quarterback
 * beating a tight end by nine, which says nothing except that
 * quarterbacks score more.
 */
const overReplacement = (p: Player) =>
  ((p.game?.["high"] ?? p.ppg) ?? 0) - ((p.ppg ?? 0) - (p.perGameVor ?? 0));

export function marginAt(
  men: Player[],
  player: Player,
  round: number,
  draft: Draft,
) {
  const pick = pickForRound(round, draft);
  /**
   * The best man there, whatever he plays. Spending a second round
   * pick on a quarterback costs you a running back, not another
   * quarterback, so comparing him with the next quarterback said every
   * one was worth a second.
   */
  const instead = bestLeftAt(men, pick, draft, player.key, null, false);
  const ourInstead = bestLeftAt(men, pick, draft, player.key, null, true);
  const his = player.perGameVor ?? 0;

  return {
    instead,
    margin: his - (instead?.perGameVor ?? 0),
    ourInstead,
    ourMargin: his - (ourInstead?.perGameVor ?? 0),
    upside: overReplacement(player) - (instead ? overReplacement(instead) : 0),
    thin: pick > 130,
  };
}

/**
 * The picks a drafter can plan around: where he is still on the board
 * three times in four, and where he is gone three times in four.
 *
 * The earliest and latest anyone has taken him are the two ends of
 * everything ever seen, which is far wider than a draft feels. The
 * quarter points say when to stop counting on him.
 */
export function usuallyAt(p: Player): string {
  const early = p.adpHigh;
  const late = p.adpLow;

  if (!p.adp) {
    return "";
  }

  if (!early || !late || late <= early) {
    return "#" + p.adp.toFixed(1);
  }

  const spread = late - early;

  return "#" + p.adp.toFixed(1) + " " +
    Math.round(early + 0.25 * spread) + "-" +
    Math.round(early + 0.75 * spread);
}

/**
 * How many rounds of value the room is handing you, or charging you.
 * Adp is an overall pick and our rank is a place in the same order, so
 * the two subtract. Under a round either way is noise in mock drafts.
 */
export function roundsOfGap(p: Player, teams: number): number {
  if (!p.rank || !p.adp) {
    return 0;
  }

  return Math.round(((p.adpRank ?? p.adp) - p.rank) / teams);
}

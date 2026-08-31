/**
 * What a drafted roster is worth, and what its picks were worth.
 *
 * Two questions, kept apart. What a man is worth to a team is his value
 * over the last man his league would start at his position. What a pick
 * was worth is where the room was taking him, since a team picking
 * third should come away with more than a team picking tenth, and a
 * rating that ignores that only says who drew the good slot.
 *
 * The room leads and our own numbers follow, because the board's cross
 * position ordering is least trustworthy where a rater would lean on
 * it: every kicker scores nothing over replacement, so the order among
 * them is arbitrary and each is handed a draft slot regardless.
 */

import { lineupOf, type Player } from "./scoring.ts";

/** the room's say against our own, and the room says more */
export const RATING_LEAN = { adp: 0.65, ours: 0.35 };

/**
 * A bench man plays only when somebody ahead of him is hurt or on a
 * bye, so he is worth a fraction of a starter and not nothing.
 */
export const ON_THE_BENCH = 0.25;

/**
 * What a pick is worth, read off where the room takes people.
 *
 * Men go in the order the room drafts them and their value over
 * replacement is smoothed along that order, so the curve says what the
 * pick buys rather than what one man happened to return.
 */
export function marketCurve(men: Player[], smoothOver = 12): number[] {
  const priced = men
    .filter((p) => p.adp !== null && p.adp !== undefined)
    .sort((a, b) => a.adp! - b.adp!);
  const curve: number[] = [];

  for (let i = 0; i < priced.length; i++) {
    const from = Math.max(0, i - smoothOver);
    const to = Math.min(priced.length, i + smoothOver + 1);
    let sum = 0;

    for (let k = from; k < to; k++) {
      sum += priced[k]!.vor ?? 0;
    }

    curve.push(sum / Math.max(1, to - from));
  }

  return curve;
}

/** what the curve says a pick at this place buys, past its end included */
export function worthAt(curve: number[], pick: number): number {
  if (curve.length === 0) {
    return 0;
  }

  const at = Math.max(0, Math.round(pick) - 1);

  return curve[Math.min(curve.length - 1, at)] ?? 0;
}

/**
 * What one man is worth, the room's price and our own number together.
 * A man nobody priced is ours alone to judge.
 */
export function worthOf(p: Player, curve: number[]): number {
  const ours = p.vor ?? 0;

  if (p.adp === null || p.adp === undefined) {
    return ours;
  }

  return RATING_LEAN.adp * worthAt(curve, p.adp) + RATING_LEAN.ours * ours;
}

export interface RosterWorth {
  /** the men who would start, in the order they fill the lineup */
  starters: { p: Player; slot: string }[];
  bench: Player[];
  /** what the starters are worth, plus the bench at a quarter */
  worth: number;
}

/**
 * The lineup this roster would put out, filled best first.
 *
 * Named slots take the best man left at that position and the flexes
 * take the best of whoever is left. A team that drafted five good backs
 * cannot start five, and a rater that adds them all up says it can.
 */
export function fillLineup(
  men: Player[], slots: string[] | null | undefined, curve: number[],
): RosterWorth {
  const { named, flex } = lineupOf(slots);
  const left = [...men].sort((a, b) => worthOf(b, curve) - worthOf(a, curve));
  const starters: { p: Player; slot: string }[] = [];
  const take = (where: (p: Player) => boolean, slot: string) => {
    const at = left.findIndex(where);

    if (at >= 0) {
      starters.push({ p: left[at]!, slot });
      left.splice(at, 1);
    }
  };

  for (const [where, count] of Object.entries(named)) {
    for (let i = 0; i < count; i++) {
      take((p) => p.position === where, where);
    }
  }

  for (let i = 0; i < flex; i++) {
    take((p) => ["RB", "WR", "TE"].includes(p.position), "FLEX");
  }

  const worth = starters.reduce((sum, s) => sum + worthOf(s.p, curve), 0) +
    left.reduce((sum, p) => sum + ON_THE_BENCH * worthOf(p, curve), 0);

  return { starters, bench: left, worth };
}

export interface TeamRating {
  owner: string;
  /** what the lineup it drafted is worth */
  got: number;
  /** and what the slots it picked from were worth */
  expected: number;
  /** the difference, which is the rating */
  over: number;
  starters: { p: Player; slot: string }[];
  bench: Player[];
}

/**
 * Every team, against what its own picks should have bought, so the
 * team that picked first is not rewarded for picking first.
 *
 * Picks arrive already paired with the men they bought, so a pick
 * nobody could look up costs a team nothing: both sides of the
 * comparison then count the same picks.
 */
export function rateTeams(
  teams: { owner: string; took: { at: number; p: Player }[] }[],
  slots: string[] | null | undefined,
  curve: number[],
): TeamRating[] {
  return teams
    .map((team) => {
      const men = team.took.map((t) => t.p);
      const filled = fillLineup(men, slots, curve);
      // the slots a lineup cannot start are discounted the way the
      // bench is, so both sides of the comparison count alike
      const starts = men.length - filled.bench.length;
      const expected = team.took
        .map((t) => t.at)
        .sort((a, b) => a - b)
        .reduce((sum, pick, i) =>
          sum + worthAt(curve, pick) * (i < starts ? 1 : ON_THE_BENCH), 0);

      return {
        owner: team.owner,
        got: filled.worth,
        expected,
        over: filled.worth - expected,
        starters: filled.starters,
        bench: filled.bench,
      };
    })
    .sort((a, b) => b.over - a.over);
}

export interface PickRating {
  at: number;
  p: Player;
  /** where the room had him, absent for a man nobody priced */
  adp: number | null;
  /** picks later than the room would have taken him, negative is a reach */
  waited: number | null;
  /** what he is worth against what the slot should have bought */
  over: number;
}

/** each pick of one draft, against where the room had the man */
export function ratePicks(
  made: { at: number; p: Player }[], curve: number[],
): PickRating[] {
  return made.map(({ at, p }) => ({
    at,
    p,
    adp: p.adp ?? null,
    waited: p.adp === null || p.adp === undefined ? null : p.adp - at,
    over: worthOf(p, curve) - worthAt(curve, at),
  }));
}

/**
 * A grade a person can read, against how the rest of this league did.
 *
 * Measured from the middle of the room rather than from nothing,
 * because the overs do not average out to nothing. A league where
 * everybody came in a little under otherwise reads as six Cs.
 */
export function gradesFor(rated: TeamRating[]): Map<string, string> {
  const overs = rated.map((t) => t.over);
  const middle = overs.reduce((a, b) => a + b, 0) / Math.max(1, overs.length);
  const spread = Math.sqrt(overs.reduce(
    (sum, v) => sum + (v - middle) ** 2, 0) / Math.max(1, overs.length));
  const said = new Map<string, string>();

  for (const team of rated) {
    const by = spread > 0 ? (team.over - middle) / spread : 0;
    said.set(
      team.owner,
      by > 1.2 ? "A" : by > 0.55 ? "B" : by > -0.2 ? "C"
        : by > -0.9 ? "D" : "F",
    );
  }

  return said;
}

/**
 * What a provider calls a side against what the play data calls it.
 * Only the Rams differ: Sleeper writes LAR and the play files write LA.
 */
const SAME_SIDE: Record<string, string> = { LAR: "LA" };

/**
 * The board's key for a man a provider named. A defence comes back as
 * "Los Angeles Rams" where the board has it as the three letters the
 * league writes on a scoreboard, so it is looked up by its team.
 */
export function keyForPick(
  pick: { name: string; position: string; team?: string | null },
  normalize: (s: string) => string,
): string {
  if (pick.position !== "DEF" || !pick.team) {
    return normalize(pick.name);
  }

  return normalize(SAME_SIDE[pick.team.toUpperCase()] ?? pick.team);
}

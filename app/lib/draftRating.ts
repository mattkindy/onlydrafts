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

/**
 * A pick is judged on what the market says, and nothing else.
 *
 * Blending our own value in here was wrong twice. The two live on
 * different scales, so averaging them and then comparing against the
 * whole curve docked everybody. And it made a column that reads as
 * "did you get a bargain" quietly mean "do we rate him", which is why
 * Derrick Henry at 1.04 came back at minus six when he went three
 * picks before ADP. What we think of a player belongs in the team
 * ratings, where it is labelled as ours.
 */

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
 * What a pick at each place bought in the draft in front of you.
 *
 * A simulated room drafting on draft position is a guess at how far men
 * fall, and this room is the answer. Smoothed wide, over two rounds
 * either side, so the trend across the slots survives and one team's
 * choice does not become its own bar.
 *
 * This makes the rating relative to the room, which is what a draft
 * grade is. The middle of the table lands near nothing by construction
 * and the grades measure who beat the room, which is what they are read
 * as anyway.
 */
export function barFromPicks(
  made: { at: number; p: Player }[], curve: number[], picks: number,
  smoothOver = 12,
): number[] {
  const worth = made
    .map((m) => ({ at: m.at, is: worthOf(m.p, curve) }))
    .sort((a, b) => a.at - b.at);

  return Array.from({ length: picks }, (_, i) => {
    const pick = i + 1;
    const near = worth.filter((w) =>
      w.at >= pick - smoothOver && w.at <= pick + smoothOver);

    if (near.length < 4) {
      return worthAt(curve, pick);
    }

    /**
     * A straight line through the window rather than its average. What
     * a pick buys falls steeply at the top, and at the third pick a
     * window either side reaches down to the twenty seventh and has
     * nothing above, so an average there falls far below the truth and
     * handed the first two rounds thirteen points of surplus.
     */
    const meanAt = near.reduce((s, w) => s + w.at, 0) / near.length;
    const meanIs = near.reduce((s, w) => s + w.is, 0) / near.length;
    const top = near.reduce(
      (s, w) => s + (w.at - meanAt) * (w.is - meanIs), 0,
    );
    const bottom = near.reduce((s, w) => s + (w.at - meanAt) ** 2, 0);
    const slope = bottom ? top / bottom : 0;

    return meanIs + slope * (pick - meanAt);
  });
}

/**
 * What one man is worth, the room's price and our own number together.
 * A man nobody priced is ours alone to judge.
 */
export function worthOf(p: Player, curve: number[]): number {
  if (p.adp === null || p.adp === undefined) {
    // nobody priced him, so the last slot on the curve is what he is
    return worthAt(curve, curve.length);
  }

  return worthAt(curve, p.adp);
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
  /**
   * and that over the picks it took, which is what teams get compared
   * on. One side made fifteen picks and another made nine, so a total
   * rewards whoever had the most turns.
   */
  perPick: number;
  picks: number;
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
  teams: {
    owner: string; took: { at: number; p: Player; kept?: boolean }[];
  }[],
  slots: string[] | null | undefined,
  curve: number[],
  /**
   * What a pick at each place buys, asked of the slot and of whether it
   * was a keeper. A man kept costs the pick he is kept at and he is
   * nearly always cheaper than one drafted there, so measuring both
   * against one bar made keeping look good for everybody and drafting
   * look bad for nine sides out of twelve.
   */
  buysAt?: (pick: number, kept: boolean) => number,
): TeamRating[] {
  const buys = (pick: number, kept: boolean) =>
    buysAt?.(pick, kept) ?? worthAt(curve, pick);

  return teams
    .map((team) => {
      const men = team.took.map((t) => t.p);
      const filled = fillLineup(men, slots, curve);
      // the slots a lineup cannot start are discounted the way the
      // bench is, so both sides of the comparison count alike
      const starts = men.length - filled.bench.length;
      const expected = [...team.took]
        .sort((a, b) => a.at - b.at)
        .reduce((sum, t, i) =>
          sum + buys(t.at, Boolean(t.kept)) *
            (i < starts ? 1 : ON_THE_BENCH), 0);

      const over = filled.worth - expected;

      return {
        owner: team.owner,
        got: filled.worth,
        expected,
        over,
        perPick: over / Math.max(1, team.took.length),
        picks: team.took.length,
        starters: filled.starters,
        bench: filled.bench,
      };
    })
    .sort((a, b) => b.perPick - a.perPick);
}

export interface PickRating {
  at: number;
  p: Player;
  /** where the room had him, absent for a man nobody priced */
  adp: number | null;
  /** how far he fell past ADP, so a minus is you reaching for him */
  fell: number | null;
  /** what he is worth against what the slot should have bought */
  over: number;
}

/** each pick of one draft, against where the room had the man */
export function ratePicks(
  made: { at: number; p: Player; kept?: boolean }[], curve: number[],
  buysAt?: (pick: number, kept: boolean) => number,
): PickRating[] {
  const buys = (pick: number, kept: boolean) =>
    buysAt?.(pick, kept) ?? worthAt(curve, pick);

  return made.map(({ at, p, kept }) => ({
    at,
    p,
    adp: p.adp ?? null,
    fell: p.adp === null || p.adp === undefined ? null : at - p.adp,
    over: worthOf(p, curve) - buys(at, Boolean(kept)),
  }));
}

/**
 * A grade a person can read, against how the rest of the league did.
 *
 * Measured off the middle of the room and a robust spread rather than
 * a mean and a standard deviation, because one team that sets fire to
 * its draft drags the average down and squashes everybody else into
 * the same letter. The median and the median distance from it do not
 * care what the two worst teams did.
 */
const BANDS: [number, string][] = [
  [0.95, "A"], [0.85, "A-"], [0.55, "B+"], [0.25, "B"], [0.05, "B-"],
  [-0.3, "C+"], [-0.6, "C"], [-1.05, "C-"], [-1.6, "D"], [-2.5, "D-"],
];

const middleOf = (of: number[]): number => {
  const sorted = [...of].sort((a, b) => a - b);
  const at = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[at]! : (sorted[at - 1]! + sorted[at]!) / 2;
};

export function gradesFor(rated: TeamRating[]): Map<string, string> {
  const overs = rated.map((t) => t.perPick);
  const middle = middleOf(overs);
  // 1.4826 turns a median distance into something a normal spread's
  // worth of bands can be read against
  const spread = 1.4826 *
    middleOf(overs.map((v) => Math.abs(v - middle)));
  const said = new Map<string, string>();

  for (const team of rated) {
    const by = spread > 0 ? (team.perPick - middle) / spread : 0;
    said.set(team.owner, BANDS.find(([edge]) => by > edge)?.[1] ?? "F");
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

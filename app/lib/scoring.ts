/**
 * What a league pays, applied to what a player does.
 *
 * The board ships what each man does in a game and leaves the scoring
 * to whoever reads it, so one board serves every league. Sleeper and
 * ESPN both name their categories, and those names are what a stat
 * line is kept under.
 */

export type Parts = Record<string, number>;
export type Pays = Record<string, number>;

export interface Player {
  name: string;
  key: string;
  position: string;
  team?: string | null;
  /** what the regression says he does in a game */
  projected?: Parts | null;
  /** and what the played out games say */
  simulated?: Parts | null;
  /** how his weeks vary against his own average, one per week */
  weeks?: { w: number; opp: string; of: number }[];
  /** the spread of a game of his, as the file scored it */
  game?: Record<string, number> | null;
  /** and of a season, with the games he is expected to play */
  sim?: (Record<string, number> & { games: number }) | null;
  adp?: number | null;
  adpLow?: number | null;
  adpHigh?: number | null;
  adpBy?: Record<string, { adp: number; low: number; high: number }> | null;
  bye?: number | null;
  touches?: number | null;
  rookie?: boolean;
  games?: number;
  /** worked out for the league in front of you */
  ppg?: number;
  vor?: number;
  perGameVor?: number;
  /**
   * What his own projection says he is worth over a season, which is
   * not what the card leads with. The board leads with what a pick at
   * his place is worth, and the two disagree whenever the room and the
   * projection do.
   */
  ownVor?: number;
  /** the regression's game on its own, one voice of the blend */
  regressionPpg?: number;
  rank?: number;
  adpRank?: number;
  ownPpg?: number;
  blend?: number;
}

/** the skill categories, under the names a league already uses */
const SKILL: Record<string, string> = {
  passYds: "pass_yd", passTd: "pass_td", interceptions: "int",
  rushYds: "rush_yd", rushTd: "rush_td",
  receptions: "rec", recYds: "rec_yd", recTd: "rec_td",
  fumblesLost: "fum_lost",
  // the board counts a man's two point plays together; a league prices
  // running one in and catching one the same, so either rate serves
  twoPointConversions: "rush_2pt",
};

const SKILL_FALLBACK: Pays = {
  pass_yd: 0.04, pass_td: 4, int: -2, rush_yd: 0.1, rush_td: 6,
  rec: 0, rec_yd: 0.1, rec_td: 6, fum_lost: -2, rush_2pt: 2,
};

/**
 * A kicker and a defence are paid by their own categories, kept under
 * the names the leagues use for them so nothing has to be translated.
 */
const THEIR_OWN_FALLBACK: Pays = {
  fgm_yds: 0.1, xpm: 1, xpmiss: -1,
  fgm_0_19: 0, fgm_20_29: 0, fgm_30_39: 0, fgm_40_49: 0, fgm_50_59: 0,
  fgm_60p: 0,
  fgmiss_0_19: -3, fgmiss_20_29: -2, fgmiss_30_39: -2, fgmiss_40_49: -1,
  fgmiss_50_59: -1, fgmiss_60p: 0,
  // the same kicks as a league that does not count them by band sees
  // them. Nothing by default, so a league using the bands is unchanged.
  fgm: 0, fgmiss: 0, fgm_50p: 0, fgmiss_50p: 0,
  sack: 1, int: 2, fum_rec: 2, def_td: 6, safe: 2, blk_kick: 2,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};

/**
 * What the board calls a category against what a league calls it. The
 * translation happens before anything asks whether we pay for it, since
 * checking the board's spelling against the league's list silently
 * dropped every kicker's field goal yardage.
 */
const ALSO_CALLED: Record<string, string> = { fgmYds: "fgm_yds" };

/**
 * How often he got the ball. The board ships these so a reader can see
 * twenty carries behind a hundred yards, and no league pays for them,
 * so they are known here and worth nothing rather than unrecognised.
 */
const COUNTED_ONLY = new Set(["passAtt", "passCmp", "carries", "targets"]);

/** every category the scorer understands, whatever it pays for it */
export const scorable = (category: string) =>
  category in SKILL || COUNTED_ONLY.has(category) ||
  (ALSO_CALLED[category] ?? category) in THEIR_OWN_FALLBACK;

/** what one game of his is worth here */
export function payFor(parts: Parts, pays: Pays): number {
  let points = 0;

  for (const [part, category] of Object.entries(SKILL)) {
    points += (parts[part] ?? 0) *
      (pays[category] ?? SKILL_FALLBACK[category] ?? 0);
  }

  for (const [part, value] of Object.entries(parts)) {
    const named = ALSO_CALLED[part] ?? part;

    if (part in SKILL || !(named in THEIR_OWN_FALLBACK)) {
      continue;
    }

    points += value * (pays[named] ?? THEIR_OWN_FALLBACK[named] ?? 0);
  }

  return points;
}

/**
 * What he scores in a game here. The walk's line leads wherever it
 * played the man, and the regression covers the men it never saw.
 */
export function scoredHere(p: Player, pays: Pays): number {
  if (p.simulated) {
    return payFor(p.simulated, pays);
  }

  if (p.projected) {
    return payFor(p.projected, pays);
  }

  return p.ppg ?? 0;
}

export interface Lineup {
  named: Record<string, number>;
  flex: number;
}

const FLEX_SLOTS = ["FLEX", "WRRB_FLEX", "REC_FLEX", "SUPER_FLEX"];

/** the lineup a league starts, split into named slots and flexes */
export function lineupOf(slots: string[] | null | undefined): Lineup {
  const named: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  let flex = 0;

  for (const slot of slots ?? ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"]) {
    if (slot in named) {
      named[slot] = (named[slot] ?? 0) + 1;
    } else if (FLEX_SLOTS.includes(slot)) {
      flex++;
    }
  }

  return { named, flex };
}

/**
 * How many of each position the league starts once flexes are shared
 * out, which is what makes one scarce and another not.
 */
export function startedHere(slots: string[] | null | undefined, teams: number) {
  const { named, flex } = lineupOf(slots);
  const share: Record<string, number> = { RB: 0.45, WR: 0.4, TE: 0.15 };
  const out: Record<string, number> = {};

  for (const [where, count] of Object.entries(named)) {
    const extra = where in share ? (share[where] ?? 0) * flex : 0;
    out[where] = Math.max(1, Math.round((count + extra) * teams));
  }

  return out;
}

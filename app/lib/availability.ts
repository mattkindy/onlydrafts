/**
 * How much of a season a player on a list is expected to play.
 *
 * The board prices him off his own injury history and his age, which
 * gives an ordinary player about thirteen or fourteen games. It does not
 * know that this one is on a list today. Josh Jacobs came out at 12.2
 * games while sitting on the not active list, so his draft position
 * from July went on reading like a bargain.
 *
 * Six games is the assumption, since that is roughly what going on
 * injured reserve costs and there is no better number for a player whose
 * return nobody has announced. It is a floor rather than a forecast.
 */

/**
 * There are two questions here, and the answer to one is not the answer
 * to the other.
 *
 * One is how much of a season a player will play, which is what the draft
 * board asks. The other is whether he plays on Sunday, which is what an
 * owner setting a lineup asks. The sets below differ on NA, because that
 * word means one thing on a draft board in July and another on a roster
 * in week eight.
 */

/**
 * The words that mean he is gone for a while rather than a week.
 *
 * NA is not one of them, whatever it looks like. It means no
 * designation, and the players carrying it are Peyton Hillis, Derek Carr
 * and Adam Thielen: retired, or a stale note nobody cleared. Reading it
 * as not active docked six games from anybody with an old flag on him.
 * Out is not one either. It is the club's word for the coming game, and
 * both Sleeper and ESPN say IR for a man who is on the list.
 */
export const OUT_FOR_A_WHILE = new Set(["IR", "PUP", "Sus", "DNR", "COV"]);

/**
 * The words that mean he does not play this week.
 *
 * NA is here, unlike in the season set. A player on somebody's roster
 * carrying it is not active, and projecting him a full week was the bug
 * an owner noticed. Questionable and Doubtful stay out of this set
 * because a questionable player mostly does play. They are not left at
 * full value either: the week's rows are scaled by `playChance` instead.
 */
export const OUT_THIS_WEEK = new Set([
  "IR", "PUP", "Sus", "DNR", "COV", "Out", "NA",
]);

/** whether the injury report says he does not play this week */
export const outThisWeek = (status: string | null | undefined) =>
  Boolean(status && OUT_THIS_WEEK.has(status));

/**
 * How often a player carrying each word really took a snap, counted over
 * the 2018 to 2025 regular seasons at QB, RB, WR, TE and K. A word this
 * table has nothing for means nobody has said anything about him, so he
 * plays.
 *
 * Doubtful is close enough to out to price it that way: 12 of the 417
 * doubtful players in eight seasons played. Questionable is the one that
 * moves a lineup.
 */
const PLAY_CHANCE: Record<string, number> = {
  Out: 0, Doubtful: 0.02, Questionable: 0.64,
};

/**
 * The same, split by what he did at practice on the last report. Thursday
 * and Friday practice splits questionable nearly in half, so where an
 * owner has that word it is worth more than the status alone.
 */
const PRACTICE_PLAY_CHANCE: Record<string, number> = {
  "Questionable|DNP": 0.43,
  "Questionable|Limited": 0.66,
  "Questionable|Full": 0.75,
};

/**
 * The chance he plays at all this week.
 *
 * Scored by Brier score on 2023 to 2025 against rates fitted on 2018 to
 * 2022: these rates land at 0.124 where treating everybody not marked out
 * as certain to play scores 0.260. An oracle that knew the scoring
 * seasons' own rates gets 0.123, so there is almost nothing left in it.
 */
export function playChance(
  status: string | null | undefined,
  practice?: string | null,
): number {
  if (!status) {
    return 1;
  }

  if (OUT_THIS_WEEK.has(status)) {
    return 0;
  }

  const told = practice
    ? PRACTICE_PLAY_CHANCE[`${status}|${practice}`]
    : undefined;

  return told ?? PLAY_CHANCE[status] ?? 1;
}

/**
 * Whether the app marks him down at all, so a caller can skip the work
 * of rewriting a row it would hand back unchanged.
 */
export const pricedDown = (status: string | null | undefined) =>
  playChance(status) < 1;

/**
 * The positions a lineup can start. The injury report is read by name,
 * and a linebacker who shares a receiver's name would otherwise rule the
 * receiver out.
 */
export const PLAYED_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** whether a listing can be about the player on this row */
export const listingFits = (his: Listed, position: string) =>
  !his.position || his.position === position;

/** what the injury report says about a player, by the board's key for him */
export interface Listed {
  /** his name as the injury report spells it, for a row written from scratch */
  name: string;
  status: string;
  /** where, since a hamstring and a thumb are different news */
  part?: string;
  position?: string;
  team?: string;
}

/** and how many games that costs him */
export const WEEKS_OUT = 6;

/** The regular season runs this many weeks, and a side plays in all but one. */
export const SEASON_WEEKS = 18;

const SEASON_GAMES = SEASON_WEEKS - 1;

/** how many of his side's games, from the coming one, the list costs him */
export function gamesOutFor(status: string | null | undefined): number {
  if (status && OUT_FOR_A_WHILE.has(status)) {
    return WEEKS_OUT;
  }

  return outThisWeek(status) ? 1 : 0;
}

/**
 * The weeks from `from` to the end of the season his side has a game in.
 * With his bye unknown a side is taken to play every week but one.
 */
export function gameWeeksFrom(from: number, bye?: number | null): number[] {
  const weeks = Array.from(
    { length: Math.max(0, SEASON_WEEKS - from + 1) }, (_, i) => from + i)
    .filter((w) => w !== bye);

  return bye == null ? weeks.slice(0, SEASON_GAMES) : weeks;
}

/**
 * The games he is expected to play from week `from` to the end of the
 * season, with the list taken into account. `games` is the board's
 * expectation over a whole season, so the weeks already gone take their
 * share of it with them. A player the board already has below what the
 * list leaves him keeps the lower number, since the board knows something
 * the list does not say.
 */
export function gamesLeft(
  games: number | undefined, status: string | null | undefined,
  from = 1, bye?: number | null,
): number {
  const left = gameWeeksFrom(from, bye).length;
  const expected = (games ?? SEASON_GAMES) * (left / SEASON_GAMES);

  return Math.min(expected, Math.max(0, left - gamesOutFor(status)));
}

/**
 * His chance of playing each week from `from` to the end of the season,
 * first week first. The list takes the games it costs him from the front,
 * and the rest share out what `gamesLeft` expects of him, so the weeks add
 * up to it. His bye is a zero.
 */
export function playsByWeek(
  games: number | undefined, status: string | null | undefined,
  from: number, bye?: number | null,
): number[] {
  const playing = gameWeeksFrom(from, bye).slice(gamesOutFor(status));
  const each = playing.length
    ? Math.min(1, gamesLeft(games, status, from, bye) / playing.length)
    : 0;
  const open = new Set(playing);

  return Array.from(
    { length: Math.max(0, SEASON_WEEKS - from + 1) },
    (_, i) => open.has(from + i) ? each : 0,
  );
}

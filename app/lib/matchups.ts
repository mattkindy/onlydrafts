/**
 * This week's head to head games, with a win chance for each side.
 *
 * The provider says what everybody has scored so far. What is left to
 * come is drawn from the week's projections, and how much is left
 * depends on where each player's game is: nothing more for a game that has
 * finished, a whole week for one that has not kicked off, and a share of
 * one for a game in progress. The public ESPN scoreboard is what says
 * which of the three a game is in, and it needs no sign in.
 *
 * Players in the same game share the factors the season draws share, and
 * what they have scored is evidence about those factors, so a
 * quarterback hot at half time lifts his receivers.
 */

import {
  factorFor, factorsOf, mixFor, normalLine, paceWeight, PASS_CATCHERS,
  posteriorDraws, posteriorFor, sharedAt, type From, type Mix, type Pace,
} from "./copula.ts";
import {
  defenceLinesFrom, statLinesFrom,
  type BoxScoreSaid, type Competitor, type DefenceLine, type StatLine,
} from "./boxScore.ts";
import {
  chanceWith, explainSwap, worthExplaining,
  type Explanation, type Opening,
} from "./explain.ts";
import type { Matchup, Side } from "./providers.ts";
import {
  FLEX_POSITIONS, knownSlot, lineupOf, slotTakes, type Player,
} from "./scoring.ts";
import type { SlateRow } from "./slate.ts";
import {
  normalCdf, normalQuantile, quantileOf, weeksFromSpread, type Spread,
} from "./spread.ts";
import { normalizeName } from "./store.ts";
import { winChance } from "./winShare.ts";

export const SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

/** one game on its own, which is the only place ESPN says who has gone off */
export const SUMMARY =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary";

/** what the sideline says about a player while his game is on */
export type InGameStatus = "out" | "doubtful" | "questionable";

/**
 * How much of the snaps still to come a player who has gone off keeps.
 *
 * A player ruled out takes no more snaps, and one questionable to return
 * misses some of them. The rest of his side is left alone, so the snaps
 * he loses go to his teammates.
 */
export const HURT_SHARE: Record<InGameStatus, number> = {
  out: 0, doubtful: 0.25, questionable: 0.5,
};

/** the same share for a player the sideline has said nothing about */
export const hurtShareOf = (status: InGameStatus | undefined) =>
  status ? HURT_SHARE[status] : 1;

export interface GameState {
  where: "pre" | "in" | "post";
  /** how much of the game is still to play, zero to one */
  left: number;
  /** who has gone off, by the key the slate gives a player */
  hurt?: Map<string, InGameStatus>;
  /** what each player has done so far, by the same key, once he has done any */
  stats?: Map<string, StatLine>;
  /** and each defence's, under its team key */
  defences?: Map<string, DefenceLine>;
}

/**
 * One game in progress, in the terms a play by play simulation of the
 * rest of it needs: who has the ball, where it is, what down it is, and
 * how much time and how many timeouts are left.
 *
 * Both teams are given by their board code, and every Record here is
 * keyed by those codes. The ball fields go missing between plays, when
 * ESPN drops the situation from the scoreboard altogether, so a caller
 * has to cope with them being undefined even for a game that is on.
 */
export interface LiveSituation {
  home: string;
  away: string;
  points: Record<string, number>;
  /** seconds left in regulation, zero once overtime starts */
  secondsLeft: number;
  /** and seconds left in the overtime period, where the game is in one */
  overtimeLeft?: number;
  withBall?: string;
  /** yards from the other team's goal line, one to ninety nine */
  yardline?: number;
  down?: number;
  toGo?: number;
  timeouts: Record<string, number>;
  redZone: boolean;
  secondHalf: boolean;
  /** the two minute warning of this half has not come round yet */
  warningLeft: boolean;
  /** who has gone off, by the key the slate gives a player */
  hurt?: Record<string, InGameStatus>;
}

/** four quarters of fifteen minutes */
const REGULATION = 60;

const SECONDS_IN_QUARTER = 900;

const SECONDS_IN_HALF = 1800;

/** and an overtime period, which is ten in the regular season */
const OVERTIME = 10;

/**
 * ESPN's code for a pro team against the board's, where the two differ.
 * Everything else already matches, including JAX.
 */
const RENAMED: Record<string, string> = { WSH: "WAS", LAR: "LA" };

const boardTeam = (abbreviation: string) => {
  const code = abbreviation.toUpperCase();

  return RENAMED[code] ?? code;
};

/** minutes and seconds off the clock, as a number of minutes */
function clockMinutes(displayClock: string | undefined): number {
  const said = /(\d+):(\d+)/.exec(displayClock ?? "");

  if (!said) {
    return 0;
  }

  return Number(said[1]) + Number(said[2]) / 60;
}

/**
 * How much of a game in progress is left, as a share of a whole game.
 *
 * Overtime counts as the minutes of the period still on the clock, since
 * a game level at the whistle has a period of scoring to come and not a
 * sliver. Callers scale a player's week by this, so a period the length
 * of a sixth of a game is worth about a sixth of one.
 */
export function fractionLeft(
  period: number | undefined, displayClock: string | undefined,
): number {
  const at = period ?? 1;
  const onTheClock = clockMinutes(displayClock);

  if (at > 4) {
    return Math.min(OVERTIME, onTheClock) / REGULATION;
  }

  const quartersToCome = Math.max(0, 4 - at) * 15;

  return Math.min(1, Math.max(0, (quartersToCome + onTheClock) / REGULATION));
}

interface ScoreboardStatus {
  period?: number;
  /** seconds left in the period, where displayClock is the same as "12:34" */
  clock?: number;
  displayClock?: string;
  type?: { state?: string };
}

interface ScoreboardCompetitor {
  homeAway?: string;
  score?: string | number;
  team?: { id?: string; abbreviation?: string };
}

interface ScoreboardSituation {
  possession?: string;
  /** counted from the goal line the team with the ball is defending */
  yardLine?: number;
  down?: number;
  distance?: number;
  homeTimeouts?: number;
  awayTimeouts?: number;
  isRedZone?: boolean;
}

interface ScoreboardCompetition {
  status?: ScoreboardStatus;
  situation?: ScoreboardSituation;
  competitors?: ScoreboardCompetitor[];
}

interface ScoreboardEvent {
  id?: string;
  status?: ScoreboardStatus;
  competitions?: ScoreboardCompetition[];
}

interface SummaryInjury {
  /** "Out", "Doubtful" or "Questionable", spelled as ESPN spells them */
  status?: string;
  /** when ESPN said it, which is what tells this from a pregame listing */
  date?: string;
  athlete?: { displayName?: string; fullName?: string };
}

interface Summary extends BoxScoreSaid {
  header?: { competitions?: { date?: string; competitors?: Competitor[] }[] };
  injuries?: { injuries?: SummaryInjury[] }[];
}

const IN_GAME: Record<string, InGameStatus> = {
  Out: "out", Doubtful: "doubtful", Questionable: "questionable",
};

/** who has gone off in one game, off that game's own summary */
export function hurtFrom(said: Summary): Map<string, InGameStatus> {
  const out = new Map<string, InGameStatus>();
  const kickoff = Date.parse(said.header?.competitions?.[0]?.date ?? "");

  for (const team of said.injuries ?? []) {
    for (const row of team.injuries ?? []) {
      const status = IN_GAME[row.status ?? ""];
      const name = row.athlete?.displayName ?? row.athlete?.fullName;

      if (!status || !name) {
        continue;
      }

      // Questionable before kickoff is the week's injury report, and he
      // is playing. Said since kickoff, he has left the field. Out means
      // no more snaps either way, whether he was a scratch or went off.
      if (status === "out" || Date.parse(row.date ?? "") >= kickoff) {
        out.set(normalizeName(name), status);
      }
    }
  }

  return out;
}

/** one game's state, read off however the scoreboard describes it */
function stateOf(status: ScoreboardStatus | undefined): GameState {
  const where = status?.type?.state === "in"
    ? "in"
    : status?.type?.state === "post" ? "post" : "pre";

  if (where === "post") {
    return { where, left: 0 };
  }

  if (where === "pre") {
    return { where, left: 1 };
  }

  return { where, left: fractionLeft(status?.period, status?.displayClock) };
}

/** what one game's own summary says, over and above the scoreboard */
export interface GameReading {
  hurt: Map<string, InGameStatus>;
  stats: Map<string, StatLine>;
  defences: Map<string, DefenceLine>;
}

/** each game's reading, by ESPN's id for the game */
export type ReadingByGame = Map<string, GameReading>;

/** every team playing this week, and where its game has got to */
export function statesFrom(said: {
  events?: ScoreboardEvent[];
}, readings?: ReadingByGame): Map<string, GameState> {
  const out = new Map<string, GameState>();

  for (const event of said.events ?? []) {
    const game = event.competitions?.[0];
    const bare = stateOf(game?.status ?? event.status);
    const its = event.id ? readings?.get(event.id) : undefined;
    const state = {
      ...bare,
      ...(its?.hurt.size ? { hurt: its.hurt } : {}),
      ...(its?.stats.size ? { stats: its.stats } : {}),
      ...(its?.defences.size ? { defences: its.defences } : {}),
    };

    for (const side of game?.competitors ?? []) {
      const code = side.team?.abbreviation;

      if (code) {
        out.set(boardTeam(code), state);
      }
    }
  }

  return out;
}

/** what the clock has left, told apart so overtime does not read as over */
export interface ClockLeft {
  /** seconds left in regulation, zero once overtime has started */
  secondsLeft: number;
  /** seconds left in the overtime period, zero while regulation is on */
  overtimeLeft: number;
}

export function clockLeftOf(status: ScoreboardStatus | undefined): ClockLeft {
  const at = status?.period ?? 1;
  const onTheClock = Math.max(0, status?.clock ?? 0);

  if (at > 4) {
    return { secondsLeft: 0, overtimeLeft: onTheClock };
  }

  return {
    secondsLeft: Math.max(0, (4 - at) * SECONDS_IN_QUARTER + onTheClock),
    overtimeLeft: 0,
  };
}

const sideOf = (
  competitors: ScoreboardCompetitor[], homeAway: string, fallback: number,
) => competitors.find((c) => c.homeAway === homeAway) ?? competitors[fallback];

const downOf = (down: number | undefined) =>
  down !== undefined && down >= 1 && down <= 4 ? down : undefined;

function situationOf(
  game: ScoreboardCompetition, status: ScoreboardStatus | undefined,
  hurt: Map<string, InGameStatus> | undefined,
): LiveSituation | undefined {
  const competitors = game.competitors ?? [];
  const home = sideOf(competitors, "home", 0);
  const away = sideOf(competitors, "away", 1);
  const homeCode = home?.team?.abbreviation;
  const awayCode = away?.team?.abbreviation;

  if (!homeCode || !awayCode) {
    return undefined;
  }

  const at = game.situation;
  const withBall = competitors.find((c) => c.team?.id === at?.possession);
  const ballCode = withBall?.team?.abbreviation;
  const { secondsLeft, overtimeLeft } = clockLeftOf(status);
  const leftInHalf = secondsLeft > SECONDS_IN_HALF
    ? secondsLeft - SECONDS_IN_HALF
    : secondsLeft;

  return {
    home: boardTeam(homeCode),
    away: boardTeam(awayCode),
    points: {
      [boardTeam(homeCode)]: Number(home?.score ?? 0),
      [boardTeam(awayCode)]: Number(away?.score ?? 0),
    },
    secondsLeft,
    ...(overtimeLeft > 0 ? { overtimeLeft } : {}),
    withBall: ballCode ? boardTeam(ballCode) : undefined,
    yardline: ballCode !== undefined && at?.yardLine !== undefined
      ? Math.min(99, Math.max(1, 100 - at.yardLine))
      : undefined,
    down: downOf(at?.down),
    toGo: downOf(at?.down) === undefined ? undefined : at?.distance,
    timeouts: {
      [boardTeam(homeCode)]: at?.homeTimeouts ?? 3,
      [boardTeam(awayCode)]: at?.awayTimeouts ?? 3,
    },
    redZone: at?.isRedZone === true,
    secondHalf: secondsLeft <= SECONDS_IN_HALF,
    warningLeft: overtimeLeft === 0 && leftInHalf > 120,
    ...(hurt?.size ? { hurt: Object.fromEntries(hurt) } : {}),
  };
}

/**
 * The games that are on, each one under both teams' board codes so a
 * lookup by either side finds it.
 */
export function situationsFrom(said: {
  events?: ScoreboardEvent[];
}, readings?: ReadingByGame): Map<string, LiveSituation> {
  const out = new Map<string, LiveSituation>();

  for (const event of said.events ?? []) {
    const game = event.competitions?.[0];
    const status = game?.status ?? event.status;

    if (!game || stateOf(status).where !== "in") {
      continue;
    }

    const live = situationOf(
      game, status, event.id ? readings?.get(event.id)?.hurt : undefined);

    if (live) {
      out.set(live.home, live);
      out.set(live.away, live);
    }
  }

  return out;
}

const nothingRead = (): GameReading => ({
  hurt: new Map<string, InGameStatus>(),
  stats: new Map<string, StatLine>(),
  defences: new Map<string, DefenceLine>(),
});

const readingFrom = (said: Summary): GameReading => ({
  hurt: hurtFrom(said),
  stats: statLinesFrom(said),
  defences: defenceLinesFrom(said),
});

/**
 * Games that have finished, so the page stops asking about them. A box
 * score that is over does not change, and on a Sunday evening a dozen
 * finished games would otherwise be read again every minute.
 */
const kept = new Map<string, GameReading>();

const summaryOf = (id: string): Promise<GameReading> =>
  fetch(`${SUMMARY}?event=${id}`)
    .then((answered) => answered.ok ? answered.json() : null)
    .then((said) => said ? readingFrom(said as Summary) : nothingRead())
    .catch(() => nothingRead());

/** a finished game is read once and then remembered for the session */
async function readingOf(
  id: string, where: GameState["where"],
): Promise<GameReading> {
  const already = kept.get(id);

  if (already) {
    return already;
  }

  const read = await summaryOf(id);

  // a read that failed is not worth remembering, since the next minute
  // may well get it
  if (where === "post" && (read.hurt.size || read.stats.size)) {
    kept.set(id, read);
  }

  return read;
}

/**
 * What each game that has kicked off says about the players in it.
 *
 * The scoreboard includes neither injuries nor a box score, so every game
 * costs a call of its own. A game that has not started is not asked
 * about, and a read that fails leaves that game saying nothing.
 */
async function readGames(
  events: ScoreboardEvent[],
): Promise<ReadingByGame> {
  const started = events
    .map((event) => ({
      id: event.id,
      where: stateOf(event.competitions?.[0]?.status ?? event.status).where,
    }))
    .filter((event) => event.id !== undefined && event.where !== "pre");
  const asked = await Promise.all(
    started.map((event) => readingOf(event.id!, event.where)));

  return new Map(started.map((event, at) => [event.id!, asked[at]!]));
}

/**
 * The scoreboard for one week. Asked for by week rather than taken as it
 * comes, because the bare scoreboard is whatever ESPN thinks today is,
 * and the page is looking at the week the slate was built for. Season
 * type two is the regular season.
 */
export async function gameStates(
  season: number, week: number,
): Promise<{
  states: Map<string, GameState>;
  situations: Map<string, LiveSituation>;
}> {
  const answered = await fetch(
    `${SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`);

  if (!answered.ok) {
    throw new Error("ESPN would not hand over the scoreboard.");
  }

  const said = await answered.json() as { events?: ScoreboardEvent[] };
  const readings = await readGames(said.events ?? []);

  return {
    states: statesFrom(said, readings),
    situations: situationsFrom(said, readings),
  };
}

/**
 * A player's week read as a spread. An older slate ships only the floor,
 * the middle and the ceiling, and then each quartile is put halfway
 * between the two figures either side of it. Halfway is narrower than
 * the quartile really is, because the residuals are skewed, so a slate
 * that ships them is taken at its word.
 */
export const spreadOf = (row: SlateRow) => ({
  ev: row.blend,
  mid: row.blend,
  low: row.floor,
  high: row.ceiling,
  q1: row.q1 ?? (row.floor + row.blend) / 2,
  q3: row.q3 ?? (row.blend + row.ceiling) / 2,
});

/** the board in this league's terms, by the key a lineup uses for a player */
export type Lines = Map<string, Player>;

/** what anybody knows about a player's week */
export interface Line {
  spread: Spread;
  position: string;
  team: string | null;
  /** the other side of his game, where the week says who it is */
  opponent: string | null;
  /** the middle of it, which is what a projected total adds up */
  blend: number;
  /**
   * True when nobody has a number for this player and the position's stock
   * week is standing in, so a page can say the figure is a guess.
   */
  stock: boolean;
}

/**
 * A plain week for a position, for a player neither the slate nor the board
 * knows. Kickers and defences are the ones this happens to, and either
 * scores about a touchdown most weeks, so counting zero was worse than
 * counting the position's usual.
 */
const STOCK: Record<string, Spread> = {
  K: { ev: 8, q1: 4.5, mid: 7.5, q3: 11, low: 2, high: 15 },
  DEF: { ev: 7, q1: 3, mid: 6, q3: 10, low: -1, high: 17 },
};

/** the stock week for a position, where there is one worth drawing */
export const stockLine = (position: string, team?: string): Line | null => {
  const spread = STOCK[position];

  if (!spread) {
    return null;
  }

  return {
    spread,
    position,
    team: team?.toUpperCase() ?? null,
    opponent: null,
    blend: spread.ev,
    stock: true,
  };
};

/**
 * What the week says about a player, and failing that what the board does.
 *
 * A slate covers the players some model was run for, which leaves out a
 * backup and a kicker nobody has a record of. Those have a season long
 * game of their own on the board, in this league's scoring, and a game
 * of that is a better guess at the rest of his Sunday than nothing at
 * all. The fixture does not come with it, so he shares no factor with
 * anybody.
 */
export function lineOf(
  key: string, rows: Map<string, SlateRow>, lines?: Lines, position?: string,
  team?: string,
): Line | null {
  const row = rows.get(key);

  if (row) {
    return {
      spread: spreadOf(row),
      position: row.position,
      team: row.team.toUpperCase(),
      opponent: row.opponent.toUpperCase() || null,
      blend: row.blend,
      stock: false,
    };
  }

  const player = lines?.get(key);
  const game = player?.game;

  if (!player || !game?.["ev"]) {
    return position ? stockLine(position, team) : null;
  }

  const ev = game["ev"]!;

  return {
    spread: {
      ev,
      mid: game["mid"] ?? ev,
      low: game["low"] ?? ev,
      high: game["high"] ?? ev,
      q1: game["q1"] ?? ev,
      q3: game["q3"] ?? ev,
    },
    position: player.position,
    team: player.team?.toUpperCase() ?? null,
    opponent: null,
    blend: ev,
    stock: false,
  };
}

/** a player on the field, as the pages that draw him need him */
export interface Starter {
  key: string;
  points?: number;
  /** the slot he is in, which says what position to fall back on */
  slot?: string;
  /** what the provider calls him, for a player nobody else has a name for */
  name?: string;
  /** his club, for a player nobody has a line on, so he still has a game */
  team?: string;
}

/** the position a slot implies, for a player nobody has a line on */
const hintOf = (slot: string | undefined) =>
  slot && slot in STOCK ? slot : undefined;

/** what the week, the board, or the position says about a player in a slot */
export const lineFor = (
  player: Starter, rows: Map<string, SlateRow>, lines?: Lines,
) => lineOf(player.key, rows, lines, hintOf(player.slot), player.team);

const NOT_STARTED: GameState = { where: "pre", left: 1 };
const OVER: GameState = { where: "post", left: 0 };

/**
 * Where his game has got to, off whichever team the line gives him.
 *
 * With no team to look up, points on the board are the only clue, and
 * anything other than zero says he has played, a negative total included:
 * a defence that gave up plenty is still a defence that has taken the
 * field. Reading him as not started would stack a whole projected week
 * on top of a score that is already final.
 */
function stateAt(
  line: Line, states: Map<string, GameState>, starter?: Starter,
): GameState {
  const known = line.team ? states.get(line.team) : null;

  if (known) {
    return known;
  }

  return (starter?.points ?? 0) !== 0 ? OVER : NOT_STARTED;
}

/** the two teams in a player's game, so both sides reach the same name */
const gameOf = (line: Line) =>
  [line.team ?? "", line.opponent ?? ""].sort().join("|");

/**
 * The live draws are all one week, so the factor a game shares needs no
 * week in its name to keep two of them apart.
 */
const THIS_WEEK = 0;

/**
 * Who each team's first pass catcher is this week, which decides the sign
 * he takes the split factor with. Kept per slate, since a week's rows are
 * read once and then asked about for every matchup on the page.
 */
const firsts = new WeakMap<Map<string, SlateRow>, Set<string>>();

function topCatchers(rows: Map<string, SlateRow>): Set<string> {
  const had = firsts.get(rows);

  if (had) {
    return had;
  }

  const best = new Map<string, [string, number]>();

  for (const [key, row] of rows) {
    if (!PASS_CATCHERS.includes(row.position)) {
      continue;
    }

    const team = row.team.toUpperCase();
    const leader = best.get(team);

    if (!leader || row.blend > leader[1]!) {
      best.set(team, [key, row.blend]);
    }
  }

  const top = new Set([...best.values()].map(([key]) => key));
  firsts.set(rows, top);

  return top;
}

/**
 * How much of his game a player has played before his pace is believed.
 *
 * Under a tenth played the weight below would be read off two minutes of
 * football, and one touchdown there would move everybody's odds, so the
 * fraction is floored here instead.
 */
const BARELY_PLAYED = 0.1;

/**
 * How much the pace is not to be trusted, as spread added to the
 * observation the posterior is given.
 *
 * The posterior sees the pace as a whole week plus noise, so the noise
 * that pulls its weight down to paceWeight is (1 - w) / w.
 */
const noiseAt = (played: number) => {
  const weight = paceWeight(Math.max(BARELY_PLAYED, played));

  return (1 - weight) / weight;
};

/** how far out a pace is read, since a quantile of zero has no normal */
const FURTHEST = 0.002;

interface Watching {
  mix: Mix;
  line: Line;
  state: GameState;
  /** what he has put up already, which no draw moves */
  scored: number;
  /** how much of his game is behind him, where it is under way */
  played: number;
  /** the normal his pace so far corresponds to */
  z: number;
}

/**
 * How a player's week was drawn, for a caller who would rather ask what his
 * own noise alone does than count the draws.
 */
export interface Drawing {
  /** what the draws give him on top of what he has already scored */
  week: number[];
  /** the five shipped figures those draws are read off */
  spread: Spread;
  mix: Mix;
  scored: number;
  /** the share of his week still to be drawn */
  left: number;
  pace: Pace;
}

/**
 * This week's draws for a run of players, sharing the factors their games
 * share and conditioned on what has been scored already.
 *
 * A player yet to kick off draws off the prior factors. A player in a game
 * under way is evidence: what he is on pace for over a full game goes on
 * his own distribution, that quantile becomes a normal, and the factors
 * his game shares are drawn from their posterior given every such player in
 * that game. Two games share no factor, so each is solved on its own.
 *
 * His own noise is partly observed too, so the rest of his own week is
 * pulled toward what the pace implies, by a weight well under the
 * fraction played.
 */
export function liveDraws(
  players: Starter[],
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws: number,
  lines?: Lines,
  remainder?: Map<string, number[]>,
): Live {
  const top = topCatchers(rows);
  const watched = new Map<string, Watching>();

  for (const player of players) {
    const line = lineFor(player, rows, lines);

    if (!line || watched.has(player.key)) {
      continue;
    }

    const state = stateAt(line, states, player);
    const played = state.where === "in"
      ? Math.min(1, Math.max(0, 1 - state.left))
      : 0;
    const at = played > 0
      ? quantileOf(line.spread, (player.points ?? 0) / played)
      : 0.5;

    watched.set(player.key, {
      mix: mixFor(
        { key: player.key, position: line.position, team: line.team },
        line.opponent,
        THIS_WEEK,
        top.has(player.key),
      ),
      line,
      state,
      scored: player.points ?? 0,
      played,
      z: normalQuantile(
        Math.min(1 - FURTHEST, Math.max(FURTHEST, at))),
    });
  }

  const posterior = new Map<string, number[]>();
  const games = new Map<string, Watching[]>();

  for (const [key, his] of watched) {
    // a live defence's running total prices a shutout it has not kept
    // yet, so its pace is no evidence about anybody's factors
    const bogus = his.line.position === "DEF" &&
      Boolean(remainder?.get(key)?.length);

    if (his.played > 0 && !bogus) {
      const game = gameOf(his.line);
      games.set(game, [...(games.get(game) ?? []), his]);
    }
  }

  for (const [game, seen] of games) {
    const factors = factorsOf(seen.map((his) => his.mix));

    if (!factors.length) {
      continue;
    }

    const solved = posteriorFor(
      seen.map((his) => ({
        mix: his.mix, z: his.z, noise: noiseAt(his.played),
      })),
      factors,
    );

    for (const [name, its] of posteriorDraws(solved, factors, game, draws)) {
      posterior.set(name, its);
    }
  }

  const from: From = (seed, want) =>
    posterior.get(seed) ?? factorFor(seed, want);
  const kept = new Map<string, number[]>();

  const drawFor = (key: string): number[] => {
    const his = watched.get(key);

    if (!his || his.state.left <= 0) {
      return new Array(draws).fill(0) as number[];
    }

    const simmed = remainder?.get(key);

    if (simmed?.length) {
      return Array.from({ length: draws },
        (_, i) => simmed[i % simmed.length]!);
    }

    const noise = his.played > 0
      ? factorFor(`${key}|left`, draws)
      : from(his.mix.ownSeed, draws);
    const us = Array.from({ length: draws }, (_, i) => {
      const { middle, width } = normalLine(
        his.mix, sharedAt(his.mix, i, draws, from), his);

      return normalCdf(middle + width * noise[i]!);
    });
    const week = weeksFromSpread(his.line.spread, key, draws, us);
    const share = Math.min(1, his.state.left) *
      hurtShareOf(his.state.hurt?.get(key));

    return share >= 1 ? week : week.map((points) => points * share);
  };

  const toCome = (key: string): number[] => {
    let his = kept.get(key);

    if (!his) {
      his = drawFor(key);
      kept.set(key, his);
    }

    return his;
  };

  return {
    draws,
    toCome,
    factorAt: from,
    drawingOf(key) {
      const his = watched.get(key);

      // the remainder engine's draws are not read off a ladder
      if (!his || remainder?.get(key)?.length) {
        return null;
      }

      return {
        week: toCome(key),
        spread: his.line.spread,
        mix: his.mix,
        scored: his.scored,
        left: Math.min(1, Math.max(0, his.state.left)),
        pace: his,
      };
    },
  };
}

/** this week's draws, with every player's answered once and kept */
export interface Live {
  draws: number;
  /** what a player might still add to a side, draw by draw */
  toCome: (key: string) => number[];
  /** what each shared factor came out at, draw by draw */
  factorAt: From;
  /** how a player's week was drawn, for a caller pricing a swap out of it */
  drawingOf: (key: string) => Drawing | null;
}

/** your own side of this week's game, and the side across from it */
export function myGameIn(
  games: Matchup[], mine: string | null, mineId?: string | null,
): { side: Side; against: Side; game: Matchup; at: number } | null {
  // the id is the one thing about a team that does not change when its
  // manager renames it, so it is tried before the name
  const isMine = (side: Side) =>
    mineId && side.ownerId ? side.ownerId === mineId : side.owner === mine;

  for (const game of games) {
    const at = game.sides.findIndex(isMine);

    if (at >= 0) {
      return {
        side: game.sides[at]!, against: game.sides[1 - at]!, game, at,
      };
    }
  }

  return null;
}

/** everybody a matchup puts on the field or on the bench */
export const playersOf = (matchup: Matchup) =>
  matchup.sides.flatMap((side) => [...side.starters, ...side.bench]);

/**
 * Whether a side has set a lineup at all. Sleeper fills every slot of an
 * unset lineup with the player id "0", which drops out with no starter
 * left behind, and ESPN can hand back a side with an empty roster the
 * same way. Either way the side has nobody in it yet, so its zero is
 * not a projection.
 */
export const hasLineup = (side: Side) => side.starters.length > 0;

/** what a side ends the week on, draw by draw */
export function sideTotals(
  side: Matchup["sides"][number],
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws: number,
  live?: Live,
  lines?: Lines,
  remainder?: Map<string, number[]>,
): number[] {
  const drawn = live ?? liveDraws(
    [...side.starters, ...side.bench], rows, states, draws, lines, remainder);
  const totals = new Array(draws).fill(0) as number[];

  for (const starter of side.starters) {
    const toCome = drawn.toCome(starter.key);

    for (let i = 0; i < draws; i++) {
      totals[i] = totals[i]! + starter.points + toCome[i]!;
    }
  }

  return totals;
}

/** how many draws a live win chance is read off */
export const LIVE_DRAWS = 4000;

const mean = (its: number[]) =>
  its.reduce((sum, n) => sum + n, 0) / Math.max(1, its.length);

export interface Standing {
  /** how often each side wins it from here */
  odds: [number, number];
  /** and what each side finishes on, on average */
  projected: [number, number];
  /**
   * what each starter still adds on average, from the same draws, so
   * the rows of a card add up to the total over them
   */
  toCome: Map<string, number>;
}

/** a matchup from here, both sides drawn against each other once */
export function standingFor(
  matchup: Matchup,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  lines?: Lines,
  draws = LIVE_DRAWS,
  remainder?: Map<string, number[]>,
): Standing {
  const live = liveDraws(playersOf(matchup), rows, states, draws, lines, remainder);
  const home = sideTotals(matchup.sides[0], rows, states, draws, live);
  const away = sideTotals(matchup.sides[1], rows, states, draws, live);
  // a side with no lineup has not lost the week, it has not set one yet,
  // so the odds stay a coin flip until both sides have a lineup to score
  const p = hasLineup(matchup.sides[0]) && hasLineup(matchup.sides[1])
    ? winChance(home, away)
    : 0.5;
  const toCome = new Map(
    matchup.sides.flatMap((side) => side.starters)
      .map((starter) => [starter.key, mean(live.toCome(starter.key))]),
  );

  return { odds: [p, 1 - p], projected: [mean(home), mean(away)], toCome };
}

/** how often each side of a matchup wins it from here */
export function oddsFor(
  matchup: Matchup,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws = LIVE_DRAWS,
  lines?: Lines,
  remainder?: Map<string, number[]>,
): [number, number] {
  return standingFor(matchup, rows, states, lines, draws, remainder).odds;
}

export interface Swap {
  /** the bench player who goes in */
  starts: string;
  /** the starter who comes out */
  benches: string;
  slot: string;
  /** what the change is worth, as win chance */
  gains: number;
}

export interface Best {
  starters: Side["starters"];
  odds: number;
  swaps: Swap[];
}

/** a player nobody can move: his game has kicked off */
const locked = (
  player: Starter, rows: Map<string, SlateRow>, states: Map<string, GameState>,
  lines?: Lines,
) => starterState(player, rows, states, lines)?.where !== "pre";

/**
 * Whether this slot takes a player of that position. A slot nobody here
 * recognises is treated as a flex where the league has any, since that is
 * what an unusual slot name nearly always is.
 */
export function slotTakesIn(
  slot: string, position: string, slots: string[] | null | undefined,
): boolean {
  if (knownSlot(slot)) {
    return slotTakes(slot, position);
  }

  return lineupOf(slots).flex > 0 && FLEX_POSITIONS.includes(position);
}

/**
 * The lineup that beats this opponent most often, and what it takes to
 * get there from the one that is set.
 *
 * Every legal single swap is tried, the best one is taken, and that
 * repeats until none of them helps. Trying every lineup is out of reach,
 * and a swap that only pays alongside another swap is rare enough to
 * lose. Both lineups are drawn against the same opponent draws, so the
 * gap between them is the lineup and not the noise.
 */
export function bestLineupFor(
  side: Side,
  against: Side,
  slots: string[] | null | undefined,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws = LIVE_DRAWS,
  lines?: Lines,
  remainder?: Map<string, number[]>,
): Best {
  const live = liveDraws(
    [...side.starters, ...side.bench, ...against.starters, ...against.bench],
    rows, states, draws, lines, remainder,
  );
  const theirs = sideTotals(against, rows, states, draws, live);
  const benched = side.bench
    .map((player) => ({ player, line: lineOf(player.key, rows, lines) }))
    .filter((his) => his.line && !locked(his.player, rows, states, lines));
  const scoredBy = (player: { key: string; points: number }, i: number) =>
    player.points + live.toCome(player.key)[i]!;
  let starters = [...side.starters];
  let bench = benched.map((his) => his.player);
  const positionOf = (key: string) => lineOf(key, rows, lines)?.position;
  let totals = Array.from({ length: draws }, (_, i) =>
    starters.reduce((sum, player) => sum + scoredBy(player, i), 0));
  let odds = winChance(totals, theirs);
  const swaps: Swap[] = [];

  for (;;) {
    let found: { swap: Swap; totals: number[] } | null = null;

    for (const player of bench) {
      const position = positionOf(player.key);

      if (!position) {
        continue;
      }

      for (const starter of starters) {
        if (
          locked(starter, rows, states, lines) ||
          !slotTakesIn(starter.slot, position, slots)
        ) {
          continue;
        }

        const swapped = totals.map((total, i) =>
          total - scoredBy(starter, i) + scoredBy(player, i));
        const gains = winChance(swapped, theirs) - odds;

        if (gains > (found?.swap.gains ?? 0)) {
          found = {
            swap: { starts: player.key, benches: starter.key, slot: starter.slot, gains },
            totals: swapped,
          };
        }
      }
    }

    if (!found) {
      return { starters, odds, swaps };
    }

    const { swap } = found;
    const out = starters.find((s) => s.key === swap.benches)!;
    starters = starters.map((s) =>
      s.key === swap.benches
        ? { key: swap.starts, slot: s.slot, points: bencher(bench, swap.starts) }
        : s);
    bench = [
      ...bench.filter((player) => player.key !== swap.starts),
      { key: out.key, points: out.points },
    ];
    totals = found.totals;
    odds += swap.gains;
    swaps.push(swap);
  }
}

const bencher = (bench: Side["bench"], key: string) =>
  bench.find((player) => player.key === key)?.points ?? 0;

/**
 * Where a starter's own game has got to, or null when nobody has a line
 * on him at all. Those two were the same answer once, and a kicker the
 * slate leaves out read as done with zero.
 */
export function starterState(
  starter: Starter,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  lines?: Lines,
): GameState | null {
  const line = lineFor(starter, rows, lines);

  return line ? stateAt(line, states, starter) : null;
}

/** what a player is projected to add from here, on top of what he has */
export const projectedFor = (
  key: string, rows: Map<string, SlateRow>, lines?: Lines, slot?: string,
) => lineFor({ key, slot }, rows, lines)?.blend ?? null;

/**
 * A name short enough for a phone: the first name cut to an initial. Only
 * the leading word goes, so a suffix or a two word surname survives.
 */
export function initialForm(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0];

  if (words.length < 2 || !first) {
    return name.trim();
  }

  return `${first[0]}. ${words.slice(1).join(" ")}`;
}

/** one bench player measured against the starter in a slot */
export interface Alternative {
  key: string;
  /** what the provider calls him, for a player nobody else has a name for */
  name?: string | undefined;
  position: string;
  /** what starting him instead would do to the win chance */
  gains: number;
  /** his game has kicked off, so the league will not take the change */
  locked: boolean;
  /**
   * Where the change in win chance comes from, for the swaps a reader
   * cannot work out from the two projections.
   */
  why?: Explanation;
}

/** a slot, who is in it, and who else could be */
export interface SlotChoice {
  slot: string;
  starter: Side["starters"][number];
  /** the starter's own game has kicked off, so he cannot come out */
  locked: boolean;
  options: Alternative[];
}

/** how many draws the alternatives are read off, per slot and per player */
export const CHOICE_DRAWS = 2000;

/**
 * Every slot in your lineup with the bench players who could take it, each
 * with what starting him would do to your chance of winning this week.
 *
 * One set of draws serves the whole board, so every answer is measured
 * against the same opponent and the differences between them are the players
 * rather than the drawing.
 */
export function alternativesFor(
  side: Side,
  against: Side,
  slots: string[] | null | undefined,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws = CHOICE_DRAWS,
  lines?: Lines,
  remainder?: Map<string, number[]>,
): SlotChoice[] {
  const live = liveDraws(
    [...side.starters, ...side.bench, ...against.starters, ...against.bench],
    rows, states, draws, lines, remainder,
  );
  const theirs = sideTotals(against, rows, states, draws, live);
  const scoredBy = (player: Starter, i: number) =>
    (player.points ?? 0) + live.toCome(player.key)[i]!;
  const totals = Array.from({ length: draws }, (_, i) =>
    side.starters.reduce((sum, player) => sum + scoredBy(player, i), 0));
  const benched = side.bench
    .map((player) => ({ player, line: lineOf(player.key, rows, lines) }))
    .filter((his) => his.line !== null);
  const factorsFor = (players: Starter[]) => factorsOf(
    players.map((player) => live.drawingOf(player.key)?.mix)
      .filter((mix): mix is Mix => mix != null));
  const theirFactors = factorsFor(against.starters);

  return side.starters.map((starter) => {
    const shut = locked(starter, rows, states, lines);
    const hisPoints = Array.from(
      { length: draws }, (_, i) => scoredBy(starter, i));
    const others = totals.map((total, i) => total - hisPoints[i]!);
    const opening: Opening = {
      others,
      theirs,
      factors: live.factorAt,
      against: theirFactors,
      alongside: factorsFor(
        side.starters.filter((player) => player.key !== starter.key)),
    };
    const his = live.drawingOf(starter.key);
    const odds = his ? chanceWith(opening, his) : winChance(totals, theirs);
    const options = benched
      .filter((one) => slotTakesIn(starter.slot, one.line!.position, slots))
      .map((one) => {
        const instead = Array.from(
          { length: draws }, (_, i) => scoredBy(one.player, i));
        const drawn = live.drawingOf(one.player.key);
        const chance = his && drawn
          ? chanceWith(opening, drawn)
          : winChance(others.map((rest, i) => rest + instead[i]!), theirs);
        const gains = chance - odds;
        const pointsGap = mean(instead) - mean(hisPoints);
        const why = his && drawn && worthExplaining(gains, pointsGap)
          ? explainSwap(opening, his, drawn)
          : undefined;

        return {
          key: one.player.key,
          name: one.player.name,
          position: one.line!.position,
          gains,
          locked: shut || locked(one.player, rows, states, lines),
          why,
        };
      })
      .sort((a, b) => b.gains - a.gains);

    return { slot: starter.slot, starter, locked: shut, options };
  });
}

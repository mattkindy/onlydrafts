/**
 * This week's head to head games, with a win chance for each side.
 *
 * The provider says what everybody has scored so far. What is left to
 * come is drawn from the week's projections, and how much is left
 * depends on where each player's game is: nothing more once it is over,
 * a whole week before kickoff, and a share of one while it is on. A
 * Sleeper league reads where each game is off Sleeper's own scores, so
 * the clock and the points come from one place, and ESPN's public
 * scoreboard covers everything else.
 *
 * Players in the same game share the factors the season draws share, and
 * what they have scored is evidence about those factors.
 */

import {
  factorFor, factorsOf, mixFor, normalLine, paceWeight, PASS_CATCHERS,
  posteriorDraws, posteriorFor, sharedAt, type From, type Mix, type Pace,
} from "./copula.ts";
import {
  chanceWith, explainSwap, worthExplaining,
  type Explanation, type Opening,
} from "./explain.ts";
import {
  clockSeconds, downOf, onTheField, type GameRead, type Where,
} from "./gameRead.ts";
import {
  sideTotalOf, type League, type Matchup, type Played, type Side,
} from "./providers.ts";
import { sleeperGames } from "./sleeperScores.ts";
import {
  FLEX_POSITIONS, knownSlot, lineupOf, slotTakes, type Player,
} from "./scoring.ts";
import type { SlateRow } from "./slate.ts";
import { boardKeyOf, boardTeamOf } from "./boardKeys.ts";
import {
  normalCdf, normalQuantile, quantileOf, weeksFromSpread, type Spread,
} from "./spread.ts";
import { weekResult, winChance } from "./winShare.ts";

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
  where: Where;
  /** how much of the game is still to play, zero to one */
  left: number;
  /** who has gone off, by the key the slate gives a player */
  hurt?: Map<string, InGameStatus>;
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
 * How much of a game in progress is left, as a share of a whole game.
 *
 * Overtime counts as the minutes of the period still on the clock, since
 * a game level at the whistle has a period of scoring to come and not a
 * sliver. Callers scale a player's week by this, so a period the length
 * of a sixth of a game is worth about a sixth of one.
 */
export function fractionLeftAt(period: number, seconds: number): number {
  const onTheClock = seconds / 60;

  if (period > 4) {
    return Math.min(OVERTIME, onTheClock) / REGULATION;
  }

  const quartersToCome = Math.max(0, 4 - period) * 15;

  return Math.min(1, Math.max(0, (quartersToCome + onTheClock) / REGULATION));
}

/** the same off ESPN's quarter and its clock as it writes it */
export const fractionLeft = (
  period: number | undefined, displayClock: string | undefined,
) => fractionLeftAt(period ?? 1, clockSeconds(displayClock) ?? 0);

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
  /** counted from the home side's own goal line, whoever has the ball */
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
  /** kickoff, as an ISO time */
  date?: string;
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

/** the part of ESPN's game summary this file reads */
interface Summary {
  header?: { competitions?: { date?: string }[] };
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
        out.set(boardKeyOf(name, undefined), status);
      }
    }
  }

  return out;
}

/** how much of a game is left, by where it has got to */
const LEFT: Record<Where, (game: GameRead) => number> = {
  pre: () => 1,
  in: (game) => fractionLeftAt(game.period, game.clock),
  post: () => 0,
};

/** what one game's own summary says, over and above the scoreboard */
export interface GameReading {
  hurt: Map<string, InGameStatus>;
}

/** each game's reading, by ESPN's id for the game */
export type ReadingByGame = Map<string, GameReading>;

/** who has gone off in each game, under both of its teams' codes */
export type HurtByTeam = Map<string, Map<string, InGameStatus>>;

const hurtIn = (game: GameRead, hurt: HurtByTeam | undefined) =>
  hurt?.get(game.home) ?? hurt?.get(game.away);

/** every team playing this week, and where its game has got to */
export function statesOf(
  games: GameRead[], hurt?: HurtByTeam,
): Map<string, GameState> {
  const out = new Map<string, GameState>();

  for (const game of games) {
    const its = hurtIn(game, hurt);
    const state: GameState = {
      where: game.where,
      left: LEFT[game.where](game),
      ...(its?.size ? { hurt: its } : {}),
    };

    out.set(game.home, state);
    out.set(game.away, state);
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

export function clockLeftAt(period: number, seconds: number): ClockLeft {
  const onTheClock = Math.max(0, seconds);

  if (period > 4) {
    return { secondsLeft: 0, overtimeLeft: onTheClock };
  }

  return {
    secondsLeft: Math.max(0, (4 - period) * SECONDS_IN_QUARTER + onTheClock),
    overtimeLeft: 0,
  };
}

/** the same off ESPN's status for a game */
export const clockLeftOf = (status: ScoreboardStatus | undefined) =>
  clockLeftAt(status?.period ?? 1, status?.clock ?? 0);

function situationOf(
  game: GameRead, hurt: Map<string, InGameStatus> | undefined,
): LiveSituation {
  const { secondsLeft, overtimeLeft } = clockLeftAt(game.period, game.clock);
  const leftInHalf = secondsLeft > SECONDS_IN_HALF
    ? secondsLeft - SECONDS_IN_HALF
    : secondsLeft;

  return {
    home: game.home,
    away: game.away,
    points: game.points,
    secondsLeft,
    ...(overtimeLeft > 0 ? { overtimeLeft } : {}),
    withBall: game.withBall,
    yardline: game.withBall === undefined ? undefined : game.yardline,
    down: game.down,
    toGo: game.down === undefined ? undefined : game.toGo,
    timeouts: game.timeouts,
    redZone: game.redZone,
    secondHalf: secondsLeft <= SECONDS_IN_HALF,
    warningLeft: overtimeLeft === 0 && leftInHalf > 120,
    ...(hurt?.size ? { hurt: Object.fromEntries(hurt) } : {}),
  };
}

/**
 * The games that are on, each one under both teams' board codes so a
 * lookup by either side finds it.
 */
export function situationsOf(
  games: GameRead[], hurt?: HurtByTeam,
): Map<string, LiveSituation> {
  const out = new Map<string, LiveSituation>();

  for (const game of games) {
    if (game.where !== "in") {
      continue;
    }

    const live = situationOf(game, hurtIn(game, hurt));

    out.set(live.home, live);
    out.set(live.away, live);
  }

  return out;
}

/** when the first game not yet started kicks off, or null if none is left */
export function nextKickoffOf(games: GameRead[]): number | null {
  const times = games
    .filter((game) => game.where === "pre")
    .map((game) => game.kickoff)
    .filter((at): at is number => at !== undefined && Number.isFinite(at));

  return times.length ? Math.min(...times) : null;
}

const ESPN_WHERE: Record<string, Where> = { in: "in", post: "post" };

const espnWhereOf = (status: ScoreboardStatus | undefined): Where =>
  ESPN_WHERE[status?.type?.state ?? ""] ?? "pre";

const sideOf = (
  competitors: ScoreboardCompetitor[], homeAway: string, fallback: number,
) => competitors.find((c) => c.homeAway === homeAway) ?? competitors[fallback];

/**
 * ESPN counts the yard line from the home side's own goal line whoever
 * has the ball, so the away side at its own 30 is at 70 and the home side
 * at its own 13 is at 13. The engine wants yards to the goal attacked.
 */
const espnYardsToGo = (yardLine: number, homeHasIt: boolean) =>
  onTheField(homeHasIt ? 100 - yardLine : yardLine);

/** an ESPN game, with the event id its summary is asked for by */
export type EspnGame = GameRead & { id?: string };

/** one scoreboard event as a game, or null when it does not say who plays */
export function espnGameOf(event: ScoreboardEvent): EspnGame | null {
  const game = event.competitions?.[0];
  const status = game?.status ?? event.status;
  const competitors = game?.competitors ?? [];
  const homeSide = sideOf(competitors, "home", 0);
  const awaySide = sideOf(competitors, "away", 1);
  const homeCode = homeSide?.team?.abbreviation;
  const awayCode = awaySide?.team?.abbreviation;

  if (!homeCode || !awayCode) {
    return null;
  }

  const home = boardTeamOf(homeCode);
  const away = boardTeamOf(awayCode);
  const at = game?.situation;
  const ballCode = competitors
    .find((c) => c.team?.id === at?.possession)?.team?.abbreviation;
  const withBall = ballCode ? boardTeamOf(ballCode) : undefined;
  const kickoff = Date.parse(event.date ?? "");
  const down = downOf(at?.down);

  return {
    ...(event.id ? { id: event.id } : {}),
    where: espnWhereOf(status),
    home,
    away,
    points: {
      [home]: Number(homeSide?.score ?? 0),
      [away]: Number(awaySide?.score ?? 0),
    },
    ...(Number.isFinite(kickoff) ? { kickoff } : {}),
    period: status?.period ?? 1,
    clock: status?.clock ?? clockSeconds(status?.displayClock) ?? 0,
    ...(withBall ? { withBall } : {}),
    ...(withBall && at?.yardLine !== undefined
      ? { yardline: espnYardsToGo(at.yardLine, withBall === home) }
      : {}),
    ...(down !== undefined ? { down } : {}),
    ...(down !== undefined && at?.distance !== undefined
      ? { toGo: at.distance }
      : {}),
    timeouts: {
      [home]: at?.homeTimeouts ?? 3,
      [away]: at?.awayTimeouts ?? 3,
    },
    redZone: at?.isRedZone === true,
  };
}

interface Scoreboard {
  events?: ScoreboardEvent[];
}

export const espnGamesFrom = (said: Scoreboard): EspnGame[] =>
  (said.events ?? [])
    .map(espnGameOf)
    .filter((game): game is EspnGame => game !== null);

/** each game's summary, moved from ESPN's id for it onto its two teams */
export function hurtByTeamFrom(
  games: EspnGame[], readings: ReadingByGame | undefined,
): HurtByTeam {
  const out: HurtByTeam = new Map();

  for (const game of games) {
    const hurt = game.id ? readings?.get(game.id)?.hurt : undefined;

    if (hurt) {
      out.set(game.home, hurt);
      out.set(game.away, hurt);
    }
  }

  return out;
}

/** every team on ESPN's scoreboard, and where its game has got to */
export function statesFrom(
  said: Scoreboard, readings?: ReadingByGame,
): Map<string, GameState> {
  const games = espnGamesFrom(said);

  return statesOf(games, hurtByTeamFrom(games, readings));
}

/** the games on ESPN's scoreboard that are on, under both teams' codes */
export function situationsFrom(
  said: Scoreboard, readings?: ReadingByGame,
): Map<string, LiveSituation> {
  const games = espnGamesFrom(said);

  return situationsOf(games, hurtByTeamFrom(games, readings));
}

export const nextKickoffFrom = (said: Scoreboard) =>
  nextKickoffOf(espnGamesFrom(said));

/**
 * Games that have finished, so the page stops asking about them. A
 * summary that is over does not change, and on a Sunday evening a dozen
 * finished games would otherwise be read again every minute.
 */
const kept = new Map<string, GameReading>();

/** one game's summary, or null when ESPN did not hand it over */
const summaryOf = (id: string): Promise<GameReading | null> =>
  fetch(`${SUMMARY}?event=${id}`)
    .then((answered) => answered.ok ? answered.json() : null)
    .then((said) => said ? { hurt: hurtFrom(said as Summary) } : null)
    .catch(() => null);

/** a finished game is read once and then remembered for the session */
async function readingOf(id: string, where: Where): Promise<GameReading> {
  const already = kept.get(id);

  if (already) {
    return already;
  }

  // a read that failed is not remembered, since the next minute may get it
  const read = await summaryOf(id);

  if (where === "post" && read) {
    kept.set(id, read);
  }

  return read ?? { hurt: new Map() };
}

/**
 * Who has gone off in each game that has kicked off. Neither scoreboard
 * says, and Sleeper has nothing newer than its weekly injury report, so
 * every started game costs a call to ESPN's summary of it. A read that
 * fails leaves that game saying nothing.
 */
async function readGames(games: EspnGame[]): Promise<ReadingByGame> {
  const started = games.filter(
    (game): game is EspnGame & { id: string } =>
      game.id !== undefined && game.where !== "pre");
  const asked = await Promise.all(
    started.map((game) => readingOf(game.id, game.where)));

  return new Map(started.map((game, at) => [game.id, asked[at]!]));
}

/**
 * ESPN's scoreboard for one week, and who has gone off in it. Asked for
 * by week rather than taken as it comes, because the bare scoreboard is
 * whatever ESPN thinks today is, and the page is looking at the week the
 * slate was built for. Season type two is the regular season.
 */
async function espnWeek(
  season: number, week: number,
): Promise<{ games: EspnGame[]; hurt: HurtByTeam }> {
  const answered = await fetch(
    `${SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`);

  if (!answered.ok) {
    throw new Error("ESPN would not hand over the scoreboard.");
  }

  const games = espnGamesFrom(await answered.json() as Scoreboard);
  const readings = await readGames(games);

  return { games, hurt: hurtByTeamFrom(games, readings) };
}

/**
 * The games a league's own provider can describe, or null for a provider
 * with no scoreboard of its own. A game it cannot read is left out, and
 * ESPN's scoreboard fills that gap.
 */
const OWN_GAMES: Record<League["provider"], (
  season: number, week: number,
) => Promise<GameRead[] | null>> = {
  sleeper: sleeperGames,
  espn: () => Promise.resolve(null),
};

/** the provider's own games, with ESPN's for any team those leave out */
export function withEspnFilling(
  own: GameRead[] | null, espn: GameRead[],
): GameRead[] {
  if (!own) {
    return espn;
  }

  const covered = new Set(own.flatMap((game) => [game.home, game.away]));
  const missing = espn.filter(
    (game) => !covered.has(game.home) && !covered.has(game.away));

  if (missing.length && own.length) {
    sayOnce(`game state for ${missing.map((g) => g.away + "@" + g.home)
      .join(", ")} comes from ESPN, since the league's feed could not say`);
  }

  return [...own, ...missing];
}

/** the week's games, read so that everything downstream prices them alike */
export interface WeekGames {
  states: Map<string, GameState>;
  situations: Map<string, LiveSituation>;
  /** the earliest kickoff among games still to start, in epoch ms */
  nextKickoff: number | null;
}

/**
 * Where every game in a week has got to. A Sleeper league reads it off
 * Sleeper, so the clock is on the same feed as the points, and ESPN's
 * scoreboard fills whatever that leaves out. ESPN's summaries are still
 * where in-game injuries come from, whoever runs the league.
 */
export async function gameStates(
  season: number, week: number, provider: League["provider"] = "espn",
): Promise<WeekGames> {
  const [espn, own] = await Promise.all([
    espnWeek(season, week).catch((e: Error) => e),
    OWN_GAMES[provider](season, week).catch((e: Error) => {
      sayOnce(`${provider}'s scores could not be read, so ESPN's stand in: ` +
        e.message);

      return null;
    }),
  ]);

  if (espn instanceof Error && !own?.length) {
    throw espn;
  }

  const games = withEspnFilling(own, espn instanceof Error ? [] : espn.games);
  const hurt = espn instanceof Error ? undefined : espn.hurt;

  return {
    states: statesOf(games, hurt),
    situations: situationsOf(games, hurt),
    nextKickoff: nextKickoffOf(games),
  };
}

/** things worth a line in the console once a session, and not every minute */
const alreadySaid = new Set<string>();

function sayOnce(message: string) {
  if (alreadySaid.has(message)) {
    return;
  }

  alreadySaid.add(message);
  console.info(message);
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

type Settle = <P extends Played & { slot?: string; team?: string }>(
  player: P) => P;

function settledSide(side: Side, settle: Settle): Side {
  const starters = side.starters.map(settle);
  const bench = side.bench.map(settle);
  const moved = starters.some((his, i) => his !== side.starters[i]) ||
    bench.some((his, i) => his !== side.bench[i]);

  if (!moved) {
    return side;
  }

  const adjustment = side.adjustment ??
    side.points - sideTotalOf(side.starters, 0);

  return {
    ...side, starters, bench, points: sideTotalOf(starters, adjustment),
  };
}

/**
 * A matchup with each finished game's players on the provider's matchup
 * figure. While a game is on, a player's points come off the same stats
 * record as his line. Once it is over the matchup feed is the result, and
 * a gap between the two is usually a stat correction, so it is logged.
 */
export function settledGame(
  game: Matchup, week: Pick<WeekPricing, "rows" | "states" | "lines">,
): Matchup {
  const settle: Settle = (player) => {
    const booked = player.booked;

    if (booked === undefined || booked === player.points) {
      return player;
    }

    const state = starterState(player, week.rows, week.states, week.lines);

    if (state?.where !== "post") {
      return player;
    }

    sayOnce(`${player.name ?? player.key} has ${booked} in the league's ` +
      `matchups for a finished game and ${player.points} off its stats, ` +
      "so the matchup figure stands");

    return { ...player, points: booked };
  };
  const sides = game.sides.map((side) => settledSide(side, settle));

  if (sides[0] === game.sides[0] && sides[1] === game.sides[1]) {
    return game;
  }

  return { ...game, sides: sides as [Side, Side] };
}

/** every game settled, or left as read until the scoreboard has answered */
export const settledGames = (
  games: Matchup[], rows: Map<string, SlateRow>,
  states: Map<string, GameState> | null, lines?: Lines,
) => states
  ? games.map((game) => settledGame(game, { rows, states, lines }))
  : games;

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

/**
 * How often the bench player beats the starter, over the draws they were
 * both read off. A tie counts half, since either owner would have taken it.
 */
export function outscoreShare(instead: number[], his: number[]): number {
  if (!instead.length) {
    return 0;
  }

  const won = instead.reduce(
    (sum, mine, i) => sum + weekResult(mine, his[i] ?? 0), 0);

  return won / instead.length;
}

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

/**
 * What pricing a week from here needs to know. Every page that prices the
 * same week has to hand over the same remainder, or two numbers on one
 * screen are drawn from different games.
 */
export interface WeekPricing {
  rows: Map<string, SlateRow>;
  states: Map<string, GameState>;
  lines?: Lines | undefined;
  /** what the remainder engine says a player in a live game still has to come */
  remainder?: Map<string, number[]> | null | undefined;
  draws?: number | undefined;
}

/** a matchup from here, both sides drawn against each other once */
export function standingFor(matchup: Matchup, week: WeekPricing): Standing {
  const { rows, states, lines, draws = LIVE_DRAWS } = week;
  const live = liveDraws(
    playersOf(matchup), rows, states, draws, lines, week.remainder ?? undefined);
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
export const oddsFor = (matchup: Matchup, week: WeekPricing): [number, number] =>
  standingFor(matchup, week).odds;

export interface Swap {
  /** the bench player who goes in */
  starts: string;
  /** the starter who comes out */
  benches: string;
  slot: string;
  /** what the change is worth, as win chance */
  gains: number;
  /** and how often the bench player puts up more points than the starter */
  outscores: number;
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
  week: WeekPricing,
): Best {
  const { rows, states, lines, draws = LIVE_DRAWS } = week;
  const live = liveDraws(
    [...side.starters, ...side.bench, ...against.starters, ...against.bench],
    rows, states, draws, lines, week.remainder ?? undefined,
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
  const drawsFor = (player: { key: string; points: number }) =>
    Array.from({ length: draws }, (_, i) => scoredBy(player, i));

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
            swap: {
              starts: player.key,
              benches: starter.key,
              slot: starter.slot,
              gains,
              outscores: outscoreShare(drawsFor(player), drawsFor(starter)),
            },
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
  /** and how often he puts up more points than the starter does */
  outscores: number;
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
  week: WeekPricing,
): SlotChoice[] {
  const { rows, states, lines, draws = CHOICE_DRAWS } = week;
  const live = liveDraws(
    [...side.starters, ...side.bench, ...against.starters, ...against.bench],
    rows, states, draws, lines, week.remainder ?? undefined,
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
          outscores: outscoreShare(instead, hisPoints),
          locked: shut || locked(one.player, rows, states, lines),
          why,
        };
      })
      .sort((a, b) => b.gains - a.gains);

    return { slot: starter.slot, starter, locked: shut, options };
  });
}

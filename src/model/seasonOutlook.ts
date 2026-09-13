/**
 * A projected NFL regular season, from point-spread style team ratings.
 *
 * A rating is a team's points against an average opponent on a neutral
 * field, so a game's expected margin is the home rating minus the away
 * rating plus home field, and the chance the home side wins is that
 * expectation read off a normal with a standard deviation of about
 * 13.5 points.
 *
 * Two fits produce ratings here, one on scoring margins and one on
 * posted betting lines, and the caller blends them. The simulation
 * takes ratings, the games played and the games left, and returns win
 * totals, division titles and playoff berths. The scripts README says
 * how the two fits are set up and what the seeding leaves out.
 */

import { normalCdf } from "../sim/normal.js";
import { seededRng } from "../sim/rng.js";

export type Conference = "AFC" | "NFC";
export type DivisionName = "East" | "North" | "South" | "West";

export interface TeamPlace {
  conference: Conference;
  division: DivisionName;
}

/** team codes as games.csv spells them */
export const TEAMS: Record<string, TeamPlace> = {
  BUF: { conference: "AFC", division: "East" },
  MIA: { conference: "AFC", division: "East" },
  NE: { conference: "AFC", division: "East" },
  NYJ: { conference: "AFC", division: "East" },
  BAL: { conference: "AFC", division: "North" },
  CIN: { conference: "AFC", division: "North" },
  CLE: { conference: "AFC", division: "North" },
  PIT: { conference: "AFC", division: "North" },
  HOU: { conference: "AFC", division: "South" },
  IND: { conference: "AFC", division: "South" },
  JAX: { conference: "AFC", division: "South" },
  TEN: { conference: "AFC", division: "South" },
  DEN: { conference: "AFC", division: "West" },
  KC: { conference: "AFC", division: "West" },
  LAC: { conference: "AFC", division: "West" },
  LV: { conference: "AFC", division: "West" },
  DAL: { conference: "NFC", division: "East" },
  NYG: { conference: "NFC", division: "East" },
  PHI: { conference: "NFC", division: "East" },
  WAS: { conference: "NFC", division: "East" },
  CHI: { conference: "NFC", division: "North" },
  DET: { conference: "NFC", division: "North" },
  GB: { conference: "NFC", division: "North" },
  MIN: { conference: "NFC", division: "North" },
  ATL: { conference: "NFC", division: "South" },
  CAR: { conference: "NFC", division: "South" },
  NO: { conference: "NFC", division: "South" },
  TB: { conference: "NFC", division: "South" },
  ARI: { conference: "NFC", division: "West" },
  LA: { conference: "NFC", division: "West" },
  SF: { conference: "NFC", division: "West" },
  SEA: { conference: "NFC", division: "West" },
};

export const TEAM_CODES: string[] = Object.keys(TEAMS);

export const DIVISION_NAMES: DivisionName[] = [
  "East",
  "North",
  "South",
  "West",
];

export const DEFAULT_MARGIN_SD = 13.5;

/** a blowout says less about a team than its first three scores do */
export const MARGIN_CAP = 21;

export interface MarginGame {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  neutralSite: boolean;
  /** how much this game counts against the others in the fit */
  weight: number;
}

export interface LineGame {
  homeTeam: string;
  awayTeam: string;
  /** closing spread, positive when the home side is favoured */
  spreadLine: number;
  neutralSite: boolean;
}

export type Ratings = Record<string, number>;

function zeroRatings(): Ratings {
  const out: Ratings = {};

  for (const team of TEAM_CODES) {
    out[team] = 0;
  }

  return out;
}

interface DesignRow {
  home: string;
  away: string;
  target: number;
  weight: number;
}

/**
 * Solves (A'WA + lambda I) r = A'Wy + lambda p for the 32 ratings, by
 * Gaussian elimination with partial pivoting. The penalty pulls a
 * rating toward its prior and keeps the system solvable when the games
 * on hand do not pin every team down, which is what happens when only
 * one week of lines has been posted.
 */
function solveRidge(
  rows: DesignRow[],
  lambda: number,
  prior: Ratings,
): Ratings {
  const n = TEAM_CODES.length;
  const index = new Map<string, number>(
    TEAM_CODES.map((team, i) => [team, i]),
  );
  const matrix = new Float64Array(n * n);
  const rhs = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    matrix[i * n + i] = lambda;
    rhs[i] = lambda * (prior[TEAM_CODES[i]!] ?? 0);
  }

  for (const row of rows) {
    const h = index.get(row.home);
    const a = index.get(row.away);

    if (h === undefined || a === undefined) {
      continue;
    }

    const w = row.weight;
    matrix[h * n + h]! += w;
    matrix[a * n + a]! += w;
    matrix[h * n + a]! -= w;
    matrix[a * n + h]! -= w;
    rhs[h]! += w * row.target;
    rhs[a]! -= w * row.target;
  }

  for (let col = 0; col < n; col++) {
    let pivot = col;

    for (let r = col + 1; r < n; r++) {
      if (Math.abs(matrix[r * n + col]!) > Math.abs(matrix[pivot * n + col]!)) {
        pivot = r;
      }
    }

    for (let c = 0; c < n; c++) {
      const held = matrix[col * n + c]!;
      matrix[col * n + c] = matrix[pivot * n + c]!;
      matrix[pivot * n + c] = held;
    }

    const heldRhs = rhs[col]!;
    rhs[col] = rhs[pivot]!;
    rhs[pivot] = heldRhs;

    const diag = matrix[col * n + col]!;

    for (let r = col + 1; r < n; r++) {
      const factor = matrix[r * n + col]! / diag;

      if (factor === 0) {
        continue;
      }

      for (let c = col; c < n; c++) {
        matrix[r * n + c]! -= factor * matrix[col * n + c]!;
      }

      rhs[r]! -= factor * rhs[col]!;
    }
  }

  const solution = new Float64Array(n);

  for (let r = n - 1; r >= 0; r--) {
    let sum = rhs[r]!;

    for (let c = r + 1; c < n; c++) {
      sum -= matrix[r * n + c]! * solution[c]!;
    }

    solution[r] = sum / matrix[r * n + r]!;
  }

  const out: Ratings = {};

  for (let i = 0; i < n; i++) {
    out[TEAM_CODES[i]!] = solution[i]!;
  }

  return centred(out);
}

/** an average team is a zero, so a rating difference reads as a spread */
export function centred(ratings: Ratings): Ratings {
  const values = TEAM_CODES.map((team) => ratings[team] ?? 0);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const out: Ratings = {};

  for (const team of TEAM_CODES) {
    out[team] = (ratings[team] ?? 0) - mean;
  }

  return out;
}

export function fitMarginRatings(
  games: MarginGame[],
  homeField: number,
  lambda: number,
): Ratings {
  const rows = games.map((game) => {
    const raw = game.homeScore - game.awayScore;
    const capped = Math.max(-MARGIN_CAP, Math.min(MARGIN_CAP, raw));
    return {
      home: game.homeTeam,
      away: game.awayTeam,
      target: capped - (game.neutralSite ? 0 : homeField),
      weight: game.weight,
    };
  });

  return solveRidge(rows, lambda, zeroRatings());
}

export function fitMarketRatings(
  lines: LineGame[],
  homeField: number,
  lambda: number,
  prior: Ratings,
): Ratings {
  const rows = lines.map((line) => ({
    home: line.homeTeam,
    away: line.awayTeam,
    target: line.spreadLine - (line.neutralSite ? 0 : homeField),
    weight: 1,
  }));

  return solveRidge(rows, lambda, prior);
}

export function blendRatings(
  market: Ratings,
  margin: Ratings,
  marketWeight: number,
): Ratings {
  const out: Ratings = {};

  for (const team of TEAM_CODES) {
    out[team] =
      marketWeight * (market[team] ?? 0) +
      (1 - marketWeight) * (margin[team] ?? 0);
  }

  return centred(out);
}

export function homeWinProbability(
  expectedMargin: number,
  marginSd: number,
): number {
  return normalCdf(expectedMargin / marginSd);
}

export interface Fixture {
  homeTeam: string;
  awayTeam: string;
  neutralSite: boolean;
}

export interface PlayedGame extends Fixture {
  homeScore: number;
  awayScore: number;
}

export interface OutlookRequest {
  ratings: Ratings;
  homeField: number;
  marginSd: number;
  played: PlayedGame[];
  remaining: Fixture[];
  iterations: number;
  seed: number;
}

export interface TeamOutlook {
  team: string;
  conference: Conference;
  division: DivisionName;
  wins: number;
  losses: number;
  ties: number;
  expectedWins: number;
  /** the 10th and 90th percentile of simulated win totals */
  winLow: number;
  winHigh: number;
  divisionOdds: number;
  playoffOdds: number;
}

interface Tally {
  /** a win plus half a tie, per team, over all games */
  points: Float64Array;
  games: Float64Array;
  divisionPoints: Float64Array;
  divisionGames: Float64Array;
  conferencePoints: Float64Array;
  conferenceGames: Float64Array;
  /** head to head points, indexed team * 32 + opponent */
  headToHead: Float64Array;
}

function emptyTally(n: number): Tally {
  return {
    points: new Float64Array(n),
    games: new Float64Array(n),
    divisionPoints: new Float64Array(n),
    divisionGames: new Float64Array(n),
    conferencePoints: new Float64Array(n),
    conferenceGames: new Float64Array(n),
    headToHead: new Float64Array(n * n),
  };
}

function copyTally(tally: Tally): Tally {
  return {
    points: tally.points.slice(),
    games: tally.games.slice(),
    divisionPoints: tally.divisionPoints.slice(),
    divisionGames: tally.divisionGames.slice(),
    conferencePoints: tally.conferencePoints.slice(),
    conferenceGames: tally.conferenceGames.slice(),
    headToHead: tally.headToHead.slice(),
  };
}

interface GamePlan {
  home: number;
  away: number;
  /** unused for a game already played */
  homeWinProbability: number;
  sameDivision: boolean;
  sameConference: boolean;
}

function addResult(
  tally: Tally,
  plan: GamePlan,
  homePoints: number,
  n: number,
): void {
  const awayPoints = 1 - homePoints;
  tally.points[plan.home]! += homePoints;
  tally.points[plan.away]! += awayPoints;
  tally.games[plan.home]! += 1;
  tally.games[plan.away]! += 1;
  tally.headToHead[plan.home * n + plan.away]! += homePoints;
  tally.headToHead[plan.away * n + plan.home]! += awayPoints;

  if (plan.sameConference) {
    tally.conferencePoints[plan.home]! += homePoints;
    tally.conferencePoints[plan.away]! += awayPoints;
    tally.conferenceGames[plan.home]! += 1;
    tally.conferenceGames[plan.away]! += 1;
  }

  if (plan.sameDivision) {
    tally.divisionPoints[plan.home]! += homePoints;
    tally.divisionPoints[plan.away]! += awayPoints;
    tally.divisionGames[plan.home]! += 1;
    tally.divisionGames[plan.away]! += 1;
  }
}

function rate(points: number, games: number): number {
  if (games === 0) {
    return 0.5;
  }

  return points / games;
}

function homePointsFor(margin: number): number {
  if (margin > 0) {
    return 1;
  }

  if (margin < 0) {
    return 0;
  }

  return 0.5;
}

/**
 * Ranks two teams level on win percentage. Head to head comes first
 * where they played, then division record for two teams in the same
 * division and conference record otherwise, then a coin flip. Strength
 * of victory, common games and net points are left out, and a tie among
 * three or more teams is settled by these pairwise comparisons rather
 * than by the reduction the league applies.
 */
function breakTie(
  a: number,
  b: number,
  tally: Tally,
  n: number,
  sameDivision: boolean,
  coin: Float64Array,
): number {
  const aHead = tally.headToHead[a * n + b]!;
  const bHead = tally.headToHead[b * n + a]!;

  if (aHead + bHead > 0 && aHead !== bHead) {
    return bHead - aHead;
  }

  if (sameDivision) {
    const divA = rate(tally.divisionPoints[a]!, tally.divisionGames[a]!);
    const divB = rate(tally.divisionPoints[b]!, tally.divisionGames[b]!);

    if (divA !== divB) {
      return divB - divA;
    }
  }

  const confA = rate(tally.conferencePoints[a]!, tally.conferenceGames[a]!);
  const confB = rate(tally.conferencePoints[b]!, tally.conferenceGames[b]!);

  if (confA !== confB) {
    return confB - confA;
  }

  return coin[b]! - coin[a]!;
}

function rank(
  a: number,
  b: number,
  tally: Tally,
  n: number,
  sameDivision: boolean,
  coin: Float64Array,
): number {
  const pctA = rate(tally.points[a]!, tally.games[a]!);
  const pctB = rate(tally.points[b]!, tally.games[b]!);

  if (pctA !== pctB) {
    return pctB - pctA;
  }

  return breakTie(a, b, tally, n, sameDivision, coin);
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const position = q * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const weight = position - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

export function projectSeason(request: OutlookRequest): TeamOutlook[] {
  const n = TEAM_CODES.length;
  const index = new Map<string, number>(
    TEAM_CODES.map((team, i) => [team, i]),
  );
  const rng = seededRng(request.seed);

  const plan = (fixture: Fixture): GamePlan | undefined => {
    const home = index.get(fixture.homeTeam);
    const away = index.get(fixture.awayTeam);

    if (home === undefined || away === undefined) {
      return undefined;
    }

    const homePlace = TEAMS[fixture.homeTeam]!;
    const awayPlace = TEAMS[fixture.awayTeam]!;
    const sameConference = homePlace.conference === awayPlace.conference;
    const edge =
      (request.ratings[fixture.homeTeam] ?? 0) -
      (request.ratings[fixture.awayTeam] ?? 0) +
      (fixture.neutralSite ? 0 : request.homeField);

    return {
      home,
      away,
      homeWinProbability: homeWinProbability(edge, request.marginSd),
      sameConference,
      sameDivision: sameConference && homePlace.division === awayPlace.division,
    };
  };

  const base = emptyTally(n);
  const wins = new Float64Array(n);
  const losses = new Float64Array(n);
  const ties = new Float64Array(n);

  for (const game of request.played) {
    const seat = plan(game);

    if (seat === undefined) {
      continue;
    }

    const homePoints = homePointsFor(game.homeScore - game.awayScore);
    addResult(base, seat, homePoints, n);
    wins[seat.home]! += homePoints === 1 ? 1 : 0;
    wins[seat.away]! += homePoints === 0 ? 1 : 0;
    losses[seat.home]! += homePoints === 0 ? 1 : 0;
    losses[seat.away]! += homePoints === 1 ? 1 : 0;
    ties[seat.home]! += homePoints === 0.5 ? 1 : 0;
    ties[seat.away]! += homePoints === 0.5 ? 1 : 0;
  }

  const upcoming: GamePlan[] = [];

  for (const fixture of request.remaining) {
    const seat = plan(fixture);

    if (seat === undefined) {
      continue;
    }

    upcoming.push(seat);
  }

  const winSamples: number[][] = Array.from({ length: n }, () => []);
  const divisionTitles = new Float64Array(n);
  const berths = new Float64Array(n);
  const coin = new Float64Array(n);
  const byDivision = new Map<string, number[]>();

  for (let i = 0; i < n; i++) {
    const place = TEAMS[TEAM_CODES[i]!]!;
    const key = `${place.conference} ${place.division}`;
    const group = byDivision.get(key) ?? [];
    group.push(i);
    byDivision.set(key, group);
  }

  for (let run = 0; run < request.iterations; run++) {
    const tally = copyTally(base);
    const seasonWins = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      seasonWins[i] = wins[i]! + 0.5 * ties[i]!;
      coin[i] = rng();
    }

    for (const game of upcoming) {
      const homeWon = rng() < game.homeWinProbability;
      addResult(tally, game, homeWon ? 1 : 0, n);
      seasonWins[homeWon ? game.home : game.away]! += 1;
    }

    for (let i = 0; i < n; i++) {
      winSamples[i]!.push(seasonWins[i]!);
    }

    for (const conference of ["AFC", "NFC"] as const) {
      const winners: number[] = [];
      const rest: number[] = [];

      for (const division of DIVISION_NAMES) {
        const group = [...byDivision.get(`${conference} ${division}`)!];
        group.sort((a, b) => rank(a, b, tally, n, true, coin));
        winners.push(group[0]!);
        rest.push(...group.slice(1));
      }

      rest.sort((a, b) => {
        const samePlace =
          TEAMS[TEAM_CODES[a]!]!.division === TEAMS[TEAM_CODES[b]!]!.division;
        return rank(a, b, tally, n, samePlace, coin);
      });

      for (const team of winners) {
        divisionTitles[team]! += 1;
        berths[team]! += 1;
      }

      for (const team of rest.slice(0, 3)) {
        berths[team]! += 1;
      }
    }
  }

  return TEAM_CODES.map((team, i) => {
    const samples = winSamples[i]!.slice().sort((a, b) => a - b);
    const place = TEAMS[team]!;
    const mean =
      samples.reduce((sum, value) => sum + value, 0) / (samples.length || 1);

    return {
      team,
      conference: place.conference,
      division: place.division,
      wins: wins[i]!,
      losses: losses[i]!,
      ties: ties[i]!,
      expectedWins: mean,
      winLow: percentile(samples, 0.1),
      winHigh: percentile(samples, 0.9),
      divisionOdds: divisionTitles[i]! / request.iterations,
      playoffOdds: berths[i]! / request.iterations,
    };
  }).sort((a, b) => b.expectedWins - a.expectedWins);
}

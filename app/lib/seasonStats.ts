/**
 * A league's season so far, and the rest of it played out.
 *
 * Everything here is worked out from the weeks the provider has already
 * scored, so it needs no model of its own until the playoff odds, which
 * need one for the weeks still to come. That model is deliberately
 * plain: each team scores a normal draw a week around what its roster
 * is projected to start, with the spread the league's own weeks show.
 * It knows nothing about matchups or injuries to come, so its numbers
 * are a fair reading of where a team stands rather than a forecast to
 * the tenth.
 */

import type { Matchup, Side } from "./providers.ts";

/** the slots a lineup starts, leaving the bench and the reserve out */
export const startingSlots = (slots: string[] | null) =>
  (slots ?? []).filter((slot) => !["BN", "IR", "TAXI"].includes(slot));

/** who can play in each slot, in the names the providers use */
const FITS: Record<string, string[]> = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

/**
 * The most a set of players could score in a lineup. Each player, best
 * first, takes the narrowest open slot he fits, so a running back fills
 * the running back slot before the flex and the flex is left for
 * whoever comes next. For lineups built of nested slots, which is every
 * lineup the two providers offer, that is the best lineup there is.
 */
export function bestLineupPoints(
  players: { points: number; position: string | undefined }[],
  slots: string[],
): number {
  const open = [...slots].sort(
    (a, b) => (FITS[a]?.length ?? 9) - (FITS[b]?.length ?? 9));
  const taken = new Array<boolean>(open.length).fill(false);
  let total = 0;

  for (const player of [...players].sort((a, b) => b.points - a.points)) {
    const at = open.findIndex((slot, i) =>
      !taken[i] && player.position !== undefined &&
      (FITS[slot] ?? [slot]).includes(player.position));

    if (at >= 0) {
      taken[at] = true;
      total += player.points;
    }
  }

  return total;
}

/** one team's season so far */
export interface TeamSeason {
  owner: string;
  wins: number;
  losses: number;
  ties: number;
  /** points for and points against */
  pf: number;
  pa: number;
  /** the record it would have playing every other team every week */
  allWins: number;
  allLosses: number;
  allTies: number;
  /** what its starters scored, and the most its roster could have */
  started: number;
  best: number;
  /** its score each week, in week order, null for a week it had no game */
  weekly: (number | null)[];
}

/** the share of games a record wins, a tie counting half */
export const winShare = (w: number, l: number, t: number) =>
  w + l + t > 0 ? (w + t / 2) / (w + l + t) : 0;

/**
 * Every team's season off the weeks played. A week's games give each
 * side its points and its opponent's; the same week's scores give the
 * all-play record; and each side's starters and bench give what the
 * lineup scored against the most it could have.
 */
export function seasonOf(
  weeks: { week: number; games: Matchup[] }[],
  slots: string[] | null,
  positionOf: (key: string) => string | undefined,
): TeamSeason[] {
  const teams = new Map<string, TeamSeason>();
  const starting = startingSlots(slots);
  const teamOf = (owner: string) => {
    let team = teams.get(owner);

    if (!team) {
      team = {
        owner, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0,
        allWins: 0, allLosses: 0, allTies: 0, started: 0, best: 0,
        weekly: weeks.map(() => null),
      };
      teams.set(owner, team);
    }

    return team;
  };
  const bestOf = (side: Side) => bestLineupPoints(
    [...side.starters, ...side.bench].map((p) => ({
      points: p.points, position: positionOf(p.key),
    })),
    starting.length ? starting : side.starters.map((s) => s.slot),
  );

  weeks.forEach(({ games }, at) => {
    const scores: { owner: string; points: number }[] = [];

    for (const game of games) {
      const [a, b] = game.sides;

      for (const [me, them] of [[a, b], [b, a]] as const) {
        const team = teamOf(me.owner);

        team.pf += me.points;
        team.pa += them.points;
        team.weekly[at] = me.points;
        team.started += me.points;
        // a best lineup can never score less than the one that played
        team.best += Math.max(me.points, bestOf(me));

        if (me.points > them.points) {
          team.wins++;
        } else if (me.points < them.points) {
          team.losses++;
        } else {
          team.ties++;
        }

        scores.push({ owner: me.owner, points: me.points });
      }
    }

    for (const one of scores) {
      const team = teamOf(one.owner);

      for (const other of scores) {
        if (other.owner === one.owner) {
          continue;
        }

        if (one.points > other.points) {
          team.allWins++;
        } else if (one.points < other.points) {
          team.allLosses++;
        } else {
          team.allTies++;
        }
      }
    }
  });

  return [...teams.values()];
}

/**
 * How many more games a team has won than its scoring earned it: its
 * wins against what its all-play share says a team that scores like it
 * wins over the same number of games.
 */
export const luckOf = (team: TeamSeason) =>
  team.wins + team.ties / 2 -
  winShare(team.allWins, team.allLosses, team.allTies) *
    (team.wins + team.losses + team.ties);

/** a team's weekly scoring, for the simulation */
export interface Strength {
  mean: number;
  sd: number;
}

/**
 * How widely a team's weeks spread around its own average, pooled over
 * the league, since eight weeks of one team say little about its spread
 * and twelve teams' worth say a good deal. A season too young to say
 * takes a quarter of the mean, which is about what a league shows.
 */
export function weeklySpread(teams: TeamSeason[], fallbackMean: number): number {
  let squares = 0;
  let count = 0;
  let kept = 0;

  for (const team of teams) {
    const played = team.weekly.filter((w): w is number => w !== null);

    if (played.length < 2) {
      continue;
    }

    const mean = played.reduce((a, b) => a + b, 0) / played.length;

    for (const week of played) {
      squares += (week - mean) ** 2;
    }

    count += played.length;
    kept++;
  }

  if (count - kept < 12) {
    return 0.25 * fallbackMean;
  }

  // a league whose weeks barely move, a few weeks in, would otherwise
  // play every remaining game out the same way every time; no league
  // spreads less than about an eighth of its mean
  return Math.max(Math.sqrt(squares / (count - kept)), 0.12 * fallbackMean);
}

/** the same random draws every time for the same inputs, so odds do not flicker */
function seeded(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a standard normal draw, from two uniform ones */
function normal(next: () => number): number {
  const u = Math.max(next(), 1e-12);

  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

export interface PlayoffOdds {
  owner: string;
  /** how often the team makes the playoffs */
  playoffs: number;
  /** how often it finishes top of the table */
  first: number;
  /** the wins it ends the regular season on, on average */
  wins: number;
}

/** the key a forced result goes under: the week's place in the run and the pair */
export const pairKey = (week: number, a: string, b: string) =>
  week + ":" + [a, b].sort().join("|");

/**
 * What a forced result says when nobody won: the game is a tie, half a
 * win to each side. No team can be called this, since team names are
 * printable.
 */
export const TIE = "\u0000tie";

/** the week's place in the run a forced result's key is for */
export const weekOfPair = (key: string) => Number(key.split(":")[0]);

/** one way your season can stand after a week still to play */
export interface PathOutcome {
  /** your wins from here through that week */
  won: number;
  /** your ties by then, which only a pick makes, so the same in every season */
  tied: number;
  /** and your games from here through it */
  played: number;
  /** how often the season goes that way */
  share: number;
  /** your playoff chance when it does */
  playoffs: number;
}

export interface PlayoffRun {
  odds: PlayoffOdds[];
  /** your odds if you win this week's game, and if you lose it */
  ifWin: number | null;
  ifLose: number | null;
  /**
   * After each week still to play, this one first, the records you can
   * have from here, how often you have each and how often you make it
   * from there. Empty without a team of yours in the table.
   */
  path: PathOutcome[][];
}

/** your playoff chance across all the ways a week can leave you */
export const chanceOf = (outcomes: PathOutcome[]) =>
  outcomes.reduce((sum, o) => sum + o.share * o.playoffs, 0);

/**
 * The playoff chance a given share of seasons sit at or under, from the
 * ways a week can leave you. Each outcome stands at the middle of its
 * share and the chance runs straight between them, so two equally
 * likely outcomes put the median halfway between their chances.
 */
export function chanceAt(outcomes: PathOutcome[], share: number): number {
  const sorted = outcomes.filter((o) => o.share > 0)
    .sort((a, b) => a.playoffs - b.playoffs);
  const total = sorted.reduce((sum, o) => sum + o.share, 0);

  if (!sorted.length || total <= 0) {
    return 0;
  }

  let before = 0;
  const marks = sorted.map((o) => {
    const mid = (before + o.share / 2) / total;

    before += o.share;
    return { mid, value: o.playoffs };
  });

  if (share <= marks[0]!.mid) {
    return marks[0]!.value;
  }

  for (let i = 1; i < marks.length; i++) {
    const lo = marks[i - 1]!;
    const hi = marks[i]!;

    if (share <= hi.mid) {
      return lo.value + ((share - lo.mid) / (hi.mid - lo.mid)) * (hi.value - lo.value);
    }
  }

  return marks[marks.length - 1]!.value;
}

/**
 * The rest of the regular season played out many times over.
 *
 * Each week still to come, each pairing draws both scores from the two
 * teams' strengths and the higher one wins. This week, where a game's
 * own odds are known from the lineups, the winner is drawn from those
 * instead. The table is ordered by wins, then by points scored, which
 * is how both providers break ties by default, and the top so many make
 * it.
 */
export function playoffOdds(input: {
  table: { owner: string; wins: number; ties: number; pf: number }[];
  /** the pairings of every week still to play, this one first */
  weeks: [string, string][][];
  strength: Map<string, Strength>;
  playoffTeams: number;
  /** this week's games with their odds, owner a beating owner b */
  thisWeek?: { a: string; b: string; odds: number; projected: [number, number] }[];
  mine?: string;
  draws?: number;
  /**
   * Results somebody has picked, by pairKey, each naming the winner, or
   * TIE. A picked game is settled before anything is drawn for it, which
   * is how the page plays out a scenario.
   */
  forced?: Map<string, string>;
}): PlayoffRun {
  const draws = input.draws ?? 5000;
  const owners = input.table.map((t) => t.owner);
  const at = new Map(owners.map((o, i) => [o, i]));
  const made = new Array<number>(owners.length).fill(0);
  const firsts = new Array<number>(owners.length).fill(0);
  const winsSum = new Array<number>(owners.length).fill(0);
  const me = input.mine !== undefined ? at.get(input.mine) : undefined;
  let wonRuns = 0, wonMade = 0, lostRuns = 0, lostMade = 0;
  const next = seeded(owners.length * 7919 + input.weeks.length * 104729 + draws);
  const thisWeek = input.thisWeek ?? [];
  const settled = new Set(thisWeek.flatMap((g) => [g.a, g.b]));
  // your games from here through each week, and for each week and each
  // number of wins by then, how many seasons went that way and made it
  const playedBy: number[] = [];
  const tiedBy: number[] = [];
  let playedSoFar = 0;
  let tiedSoFar = 0;

  input.weeks.forEach((pairs, w) => {
    const mine = me === undefined ? undefined : pairs.find(([a, b]) =>
      (at.get(a) === me && at.has(b)) || (at.get(b) === me && at.has(a)));

    playedSoFar += Number(mine !== undefined);
    tiedSoFar += Number(mine !== undefined &&
      input.forced?.get(pairKey(w, mine[0], mine[1])) === TIE);
    playedBy.push(playedSoFar);
    tiedBy.push(tiedSoFar);
  });

  const ways = playedBy.map((n) => new Array<number>(n + 1).fill(0));
  const waysMade = playedBy.map((n) => new Array<number>(n + 1).fill(0));
  const trail = new Array<number>(input.weeks.length).fill(0);

  // every game to come worked out once, so a season played out is only
  // numbers: who plays whom, a picked winner, or this week's known odds
  const meanOf = owners.map((o) => input.strength.get(o)?.mean ?? 0);
  const sdOf = owners.map((o) => input.strength.get(o)?.sd ?? 0);
  const plan = input.weeks.map((pairs, w) => pairs.flatMap(([a, b]) => {
    const ia = at.get(a);
    const ib = at.get(b);

    if (ia === undefined || ib === undefined) {
      return [];
    }

    const picked = input.forced?.get(pairKey(w, a, b));
    const game = w === 0 && settled.has(a)
      ? thisWeek.find((g) => (g.a === a && g.b === b) || (g.a === b && g.b === a))
      : undefined;
    const known = game && {
      oddsA: game.a === a ? game.odds : 1 - game.odds,
      pa: game.a === a ? game.projected[0] : game.projected[1],
      pb: game.a === a ? game.projected[1] : game.projected[0],
    };

    return [{
      ia, ib, known,
      picked: picked === undefined ? null : picked === TIE ? "tie" as const : picked === a,
      mine: me !== undefined && (ia === me || ib === me),
    }];
  }));
  const startWins = input.table.map((t) => t.wins + t.ties / 2);
  const startPf = input.table.map((t) => t.pf);
  const wins = startWins.slice();
  const pf = startPf.slice();
  const order = owners.map((_, i) => i);

  for (let run = 0; run < draws; run++) {
    for (let i = 0; i < owners.length; i++) {
      wins[i] = startWins[i]!;
      pf[i] = startPf[i]!;
    }

    let iWon: boolean | null = null;
    let mineWon = 0;

    plan.forEach((games, w) => {
      for (const { ia, ib, known, picked, mine } of games) {
        let aWins: boolean;

        if (picked === "tie") {
          // half a win each, and each side's usual score toward points for
          wins[ia]! += 0.5;
          wins[ib]! += 0.5;
          pf[ia] = pf[ia]! + (known ? known.pa : meanOf[ia]!);
          pf[ib] = pf[ib]! + (known ? known.pb : meanOf[ib]!);
          continue;
        } else if (picked !== null) {
          // the scores still count toward points for: this week's lineups
          // where the game has them, and each side's usual otherwise
          aWins = picked;
          pf[ia] = pf[ia]! + (known ? known.pa : meanOf[ia]!);
          pf[ib] = pf[ib]! + (known ? known.pb : meanOf[ib]!);
        } else if (known) {
          aWins = next() < known.oddsA;
          pf[ia] = pf[ia]! + known.pa;
          pf[ib] = pf[ib]! + known.pb;
        } else {
          const xa = meanOf[ia]! + sdOf[ia]! * normal(next);
          const xb = meanOf[ib]! + sdOf[ib]! * normal(next);

          aWins = xa > xb;
          pf[ia] = pf[ia]! + xa;
          pf[ib] = pf[ib]! + xb;
        }

        wins[aWins ? ia : ib]! += 1;

        if (mine) {
          const won = (ia === me) === aWins;

          mineWon += Number(won);

          if (w === 0) {
            iWon = won;
          }
        }
      }

      trail[w] = mineWon;
    });

    order.sort((x, y) => wins[y]! - wins[x]! || pf[y]! - pf[x]! || x - y);

    order.slice(0, input.playoffTeams).forEach((i) => { made[i]!++; });
    firsts[order[0]!]!++;
    owners.forEach((_, i) => { winsSum[i]! += wins[i]!; });

    if (me === undefined) {
      continue;
    }

    const inIt = order.slice(0, input.playoffTeams).includes(me);

    trail.forEach((won, w) => {
      ways[w]![won]! += 1;
      waysMade[w]![won]! += Number(inIt);
    });

    if (iWon !== null) {
      if (iWon) {
        wonRuns++;
        wonMade += Number(inIt);
      } else {
        lostRuns++;
        lostMade += Number(inIt);
      }
    }
  }

  return {
    odds: owners.map((owner, i) => ({
      owner,
      playoffs: made[i]! / draws,
      first: firsts[i]! / draws,
      wins: winsSum[i]! / draws,
    })),
    ifWin: wonRuns ? wonMade / wonRuns : null,
    ifLose: lostRuns ? lostMade / lostRuns : null,
    path: me === undefined ? [] : ways.map((counts, w) =>
      counts.flatMap((seasons, won): PathOutcome[] => seasons
        ? [{
          won,
          tied: tiedBy[w]!,
          played: playedBy[w]!,
          share: seasons / draws,
          playoffs: waysMade[w]![won]! / seasons,
        }]
        : [])),
  };
}

/** a set of picks as one string, the same however they were made */
export const picksSignature = (picks: Map<string, string>) =>
  [...picks].map(([key, winner]) => key + "=" + winner).sort().join(",");

export interface ScenarioPath {
  /** your chance today, before any pick has happened */
  now: number;
  /** after each week, the ways your season can stand then */
  cols: PathOutcome[][];
}

/**
 * Your chance as this tab would tell it each week if the season goes as
 * picked. A pick is not known until its week is played, so the path
 * starts from today's chance and moves when a picked game happens: up
 * for a win, down for a loss, and either way for a rival's result.
 *
 * Each week is played out with only the picks up to it settled, and the
 * weeks that share a set of settled picks share a run, so nothing picked
 * means one run for the whole path.
 */
export function scenarioPath(input: {
  forced: Map<string, string>;
  /** how many weeks the path runs */
  weeks: number;
  mine: string;
  /** the season played out with these picks */
  playOut: (picks: Map<string, string>) => PlayoffRun;
  /**
   * Runs already played, by picksSignature, which this adds to: a pick
   * leaves the weeks before it as they were, so they are not played again.
   */
  runs?: Map<string, PlayoffRun>;
}): ScenarioPath {
  const runs = input.runs ?? new Map<string, PlayoffRun>();
  const runFor = (picks: Map<string, string>) => {
    const key = picksSignature(picks);
    let run = runs.get(key);

    if (!run) {
      run = input.playOut(picks);
      runs.set(key, run);
    }

    return run;
  };
  const through = (week: number) =>
    new Map([...input.forced].filter(([key]) => weekOfPair(key) <= week));
  const today = runFor(through(-1));

  return {
    now: today.odds.find((o) => o.owner === input.mine)?.playoffs ?? 0,
    cols: Array.from({ length: input.weeks }, (_, w) => runFor(through(w)).path[w] ?? []),
  };
}

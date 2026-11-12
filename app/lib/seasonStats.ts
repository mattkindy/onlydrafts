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
import type { PlayoffRules, Tiebreak } from "./playoffRules.ts";

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
  /** its wins against each week's median score, a tie counting half */
  medianWins: number;
  /** its record against each team it has played, a tie counting half a win */
  versus: Record<string, { won: number; games: number }>;
  /** what its starters scored, and the most its roster could have */
  started: number;
  best: number;
  /** its score each week, in week order, null for a week it had no game */
  weekly: (number | null)[];
}

/** the middle of some scores, halfway between the two middle ones when they are even */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (!sorted.length) {
    return 0;
  }

  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
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
        allWins: 0, allLosses: 0, allTies: 0, medianWins: 0, versus: {}, started: 0, best: 0,
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

        const versus = team.versus[them.owner] ??= { won: 0, games: 0 };

        versus.games++;

        if (me.points > them.points) {
          team.wins++;
          versus.won++;
        } else if (me.points < them.points) {
          team.losses++;
        } else {
          team.ties++;
          versus.won += 0.5;
        }

        scores.push({ owner: me.owner, points: me.points });
      }
    }

    const middle = medianOf(scores.map((one) => one.points));

    for (const one of scores) {
      const team = teamOf(one.owner);

      team.medianWins += one.points > middle ? 1 : one.points === middle ? 0.5 : 0;

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
  /** how often it wins its division, where division winners get in */
  division?: number;
  /** how often it wins the title, where the playoff weeks were handed in */
  champion?: number;
  /** how often it sits out the first round, where a short field gives byes */
  bye?: number;
}

/**
 * How many weeks a bracket of this many teams takes, one round a week:
 * six teams is three, the top two sitting out the first.
 */
export const playoffRounds = (teams: number) =>
  teams < 2 ? 0 : Math.ceil(Math.log2(teams));

/**
 * The seeds down a bracket of `size` places, top seed first, so that
 * neighbours meet: 1 8 4 5 2 7 3 6. A seed past the teams that made it
 * is a bye for whoever it was drawn against.
 */
export function bracketSlots(size: number): number[] {
  let slots = [1];

  while (slots.length < size) {
    const n = slots.length * 2;

    slots = slots.flatMap((s) => [s, n + 1 - s]);
  }

  return slots;
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

/** one team's place in the table the rest of the season starts from */
export interface SeedRow {
  owner: string;
  wins: number;
  ties: number;
  pf: number;
  pa?: number;
  allWins?: number;
  allLosses?: number;
  allTies?: number;
  medianWins?: number;
  versus?: Record<string, { won: number; games: number }>;
}

const PLAIN_RULES: Pick<PlayoffRules, "seedBy" | "ties" | "divisions"> = {
  seedBy: "wins", ties: ["pf"], divisions: false,
};

/**
 * The rest of the regular season played out many times over.
 *
 * Each week still to come, each pairing draws both scores from the two
 * teams' strengths and the higher one wins. This week, where a game's
 * own odds are known from the lineups, the winner is drawn from those
 * instead. The table is then ranked the league's way: by record, record
 * with a game against each week's median, all-play or points for, with
 * its tiebreakers in order and a coin flip after them. Where division
 * winners get in, each division's best team does, and the best of the
 * rest fill the places left.
 *
 * With `byWeek`, each week is drawn from that week's strengths, so a bye
 * or a starter back from reserve lands in the week it happens. With
 * `bracket`, the teams that made it then play the playoffs a round a
 * week, division winners seeded first, the top seeds sitting out the
 * first round where the field is short of a full bracket. Those games
 * are drawn from a stream of their own, a fixed number a season, so two
 * versions of a league played out side by side still meet the same luck
 * in the playoffs.
 */
export function playoffOdds(input: {
  table: SeedRow[];
  /** the pairings of every week still to play, this one first */
  weeks: [string, string][][];
  strength: Map<string, Strength>;
  /** each week's strengths, lined up with `weeks`; `strength` where a week has none */
  byWeek?: Map<string, Strength>[];
  /** each playoff round's strengths, the first round first */
  bracket?: Map<string, Strength>[];
  playoffTeams: number;
  /** how the table is ranked; by record, then points for, without */
  rules?: Pick<PlayoffRules, "seedBy" | "ties" | "divisions">;
  /** each team's division, where division winners get in */
  divisionOf?: Map<string, number>;
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
  const rules = input.rules ?? PLAIN_RULES;
  const owners = input.table.map((t) => t.owner);
  const n = owners.length;
  const at = new Map(owners.map((o, i) => [o, i]));
  const made = new Array<number>(n).fill(0);
  const firsts = new Array<number>(n).fill(0);
  const titles = new Array<number>(n).fill(0);
  const winsSum = new Array<number>(n).fill(0);
  const champions = new Array<number>(n).fill(0);
  const byes = new Array<number>(n).fill(0);
  const me = input.mine !== undefined ? at.get(input.mine) : undefined;
  let wonRuns = 0, wonMade = 0, lostRuns = 0, lostMade = 0;
  const next = seeded(n * 7919 + input.weeks.length * 104729 + draws);
  const thisWeek = input.thisWeek ?? [];
  const settled = new Set(thisWeek.flatMap((g) => [g.a, g.b]));

  // what the ranking needs kept beyond wins and points for
  const uses = (tie: Tiebreak) => rules.ties.includes(tie);
  const needAll = rules.seedBy === "allplay" || uses("allplay");
  const needMedian = rules.seedBy === "median";
  const needPairs = uses("h2h") || uses("division");
  const needPa = uses("paMost") || uses("paFewest");
  const division = owners.map((o) => input.divisionOf?.get(o) ?? null);
  const divisionIds = rules.divisions
    ? [...new Set(division.filter((d): d is number => d !== null))]
    : [];
  const byDivision = divisionIds.length > 1;

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

  const ways = playedBy.map((count) => new Array<number>(count + 1).fill(0));
  const waysMade = playedBy.map((count) => new Array<number>(count + 1).fill(0));
  const trail = new Array<number>(input.weeks.length).fill(0);

  // every game to come worked out once, so a season played out is only
  // numbers: who plays whom, a picked winner, or this week's known odds
  const strengthAt = (w: number) => input.byWeek?.[w] ?? input.strength;
  const meanAt = input.weeks.map((_, w) => owners.map((o) => strengthAt(w).get(o)?.mean ?? 0));
  const sdAt = input.weeks.map((_, w) => owners.map((o) => strengthAt(w).get(o)?.sd ?? 0));

  // the playoffs: each round's strengths, and the bracket the seeds fill
  const rounds = input.bracket?.length ? playoffRounds(input.playoffTeams) : 0;
  const roundMean = Array.from({ length: rounds }, (_, r) => {
    const s = input.bracket![Math.min(r, input.bracket!.length - 1)]!;

    return owners.map((o) => s.get(o)?.mean ?? 0);
  });
  const roundSd = Array.from({ length: rounds }, (_, r) => {
    const s = input.bracket![Math.min(r, input.bracket!.length - 1)]!;

    return owners.map((o) => s.get(o)?.sd ?? 0);
  });
  const slots = rounds ? bracketSlots(2 ** rounds) : [];
  // the top seeds of a short field go straight to the second round
  const byeCount = rounds ? 2 ** rounds - Math.min(input.playoffTeams, n) : 0;
  const playoffDice = seeded(n * 31 + input.playoffTeams * 7 + draws);
  const seeds: number[] = [];
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
      picked: picked === undefined ? null : picked === TIE ? 0.5 : picked === a ? 1 : 0,
      mine: me !== undefined && (ia === me || ib === me),
    }];
  }));

  // the table the season starts from, and the same kept for each season
  const startWins = input.table.map((t) => t.wins + t.ties / 2);
  const startPf = input.table.map((t) => t.pf);
  const startPa = input.table.map((t) => t.pa ?? 0);
  const startAllWon = input.table.map((t) => (t.allWins ?? 0) + (t.allTies ?? 0) / 2);
  const startAllGames = input.table.map((t) =>
    (t.allWins ?? 0) + (t.allLosses ?? 0) + (t.allTies ?? 0));
  const startMedian = input.table.map((t) => t.medianWins ?? 0);
  const startPairWon = new Float64Array(n * n);
  const startPairGames = new Float64Array(n * n);

  input.table.forEach((t, i) => {
    for (const [them, record] of Object.entries(t.versus ?? {})) {
      const j = at.get(them);

      if (j !== undefined) {
        startPairWon[i * n + j] = record.won;
        startPairGames[i * n + j] = record.games;
      }
    }
  });

  const wins = startWins.slice();
  const pf = startPf.slice();
  const pa = startPa.slice();
  const allWon = startAllWon.slice();
  const allGames = startAllGames.slice();
  const median = startMedian.slice();
  const pairWon = new Float64Array(n * n);
  const pairGames = new Float64Array(n * n);
  const score = new Float64Array(n).fill(NaN);
  const primary = new Float64Array(n);
  const inIt = new Uint8Array(n);
  const order = owners.map((_, i) => i);

  /** a team's share of games against these others, half where it has none */
  const shareAgainst = (i: number, others: (j: number) => boolean) => {
    let won = 0, games = 0;

    for (let j = 0; j < n; j++) {
      if (j !== i && others(j)) {
        won += pairWon[i * n + j]!;
        games += pairGames[i * n + j]!;
      }
    }

    return games ? won / games : 0.5;
  };
  const keyOf = (tie: Tiebreak, i: number, group: number[]): number => {
    switch (tie) {
      case "h2h": return shareAgainst(i, (j) => group.includes(j));
      case "division": return division[i] === null ? 0.5
        : shareAgainst(i, (j) => division[j] === division[i]);
      case "pf": return pf[i]!;
      case "paMost": return pa[i]!;
      case "paFewest": return -pa[i]!;
      case "allplay": return allGames[i] ? allWon[i]! / allGames[i]! : 0;
      case "wins": return wins[i]!;
    }
  };

  /** puts order[from..to), all level so far, in order by the tiebreakers from this one */
  const settle = (from: number, to: number, layer: number) => {
    const group = order.slice(from, to);

    if (layer >= rules.ties.length) {
      // a coin flip for whoever is still level
      for (let k = group.length - 1; k > 0; k--) {
        const pick = Math.floor(next() * (k + 1));

        [group[k], group[pick]] = [group[pick]!, group[k]!];
      }

      group.forEach((team, k) => { order[from + k] = team; });
      return;
    }

    const tie = rules.ties[layer]!;
    const keys = new Map(group.map((team) => [team, keyOf(tie, team, group)]));

    group.sort((x, y) => keys.get(y)! - keys.get(x)!);
    group.forEach((team, k) => { order[from + k] = team; });

    for (let k = from; k < to;) {
      let end = k + 1;

      while (end < to && keys.get(order[end]!) === keys.get(order[k]!)) {
        end++;
      }

      if (end - k > 1) {
        settle(k, end, layer + 1);
      }

      k = end;
    }
  };

  for (let run = 0; run < draws; run++) {
    for (let i = 0; i < n; i++) {
      wins[i] = startWins[i]!;
      pf[i] = startPf[i]!;
      pa[i] = startPa[i]!;
      allWon[i] = startAllWon[i]!;
      allGames[i] = startAllGames[i]!;
      median[i] = startMedian[i]!;
    }

    if (needPairs) {
      pairWon.set(startPairWon);
      pairGames.set(startPairGames);
    }

    let iWon: boolean | null = null;
    let mineWon = 0;

    plan.forEach((games, w) => {
      for (const { ia, ib, known, picked, mine } of games) {
        let sa: number, sb: number, resultA: number;

        if (picked !== null) {
          // a picked game still scores toward points for: this week's
          // lineups where the game has them, and each side's usual otherwise
          resultA = picked;
          sa = known ? known.pa : meanAt[w]![ia]!;
          sb = known ? known.pb : meanAt[w]![ib]!;
        } else if (known) {
          resultA = next() < known.oddsA ? 1 : 0;
          sa = known.pa;
          sb = known.pb;
        } else {
          sa = meanAt[w]![ia]! + sdAt[w]![ia]! * normal(next);
          sb = meanAt[w]![ib]! + sdAt[w]![ib]! * normal(next);
          resultA = sa > sb ? 1 : 0;
        }

        wins[ia]! += resultA;
        wins[ib]! += 1 - resultA;
        pf[ia] = pf[ia]! + sa;
        pf[ib] = pf[ib]! + sb;

        if (needPa) {
          pa[ia] = pa[ia]! + sb;
          pa[ib] = pa[ib]! + sa;
        }

        if (needAll || needMedian) {
          score[ia] = sa;
          score[ib] = sb;
        }

        if (needPairs) {
          pairWon[ia * n + ib]! += resultA;
          pairWon[ib * n + ia]! += 1 - resultA;
          pairGames[ia * n + ib]! += 1;
          pairGames[ib * n + ia]! += 1;
        }

        // a tie is neither the win nor the loss your path counts
        if (mine && resultA !== 0.5) {
          const won = (ia === me) === (resultA === 1);

          mineWon += Number(won);

          if (w === 0) {
            iWon = won;
          }
        }
      }

      if (needAll || needMedian) {
        const playing: number[] = [];

        for (let i = 0; i < n; i++) {
          if (!Number.isNaN(score[i]!)) {
            playing.push(i);
          }
        }

        if (needAll) {
          for (const i of playing) {
            for (const j of playing) {
              if (i !== j) {
                allWon[i] = allWon[i]! + (score[i]! > score[j]! ? 1 : score[i] === score[j] ? 0.5 : 0);
                allGames[i] = allGames[i]! + 1;
              }
            }
          }
        }

        if (needMedian && playing.length) {
          const middle = medianOf(playing.map((i) => score[i]!));

          for (const i of playing) {
            median[i] = median[i]! + (score[i]! > middle ? 1 : score[i] === middle ? 0.5 : 0);
          }
        }

        score.fill(NaN);
      }

      trail[w] = mineWon;
    });

    for (let i = 0; i < n; i++) {
      primary[i] = rules.seedBy === "wins" ? wins[i]!
        : rules.seedBy === "median" ? wins[i]! + median[i]!
        : rules.seedBy === "allplay" ? (allGames[i] ? allWon[i]! / allGames[i]! : 0)
        : pf[i]!;
    }

    order.sort((x, y) => primary[y]! - primary[x]! || x - y);

    for (let k = 0; k < n;) {
      let end = k + 1;

      while (end < n && primary[order[end]!] === primary[order[k]!]) {
        end++;
      }

      if (end - k > 1) {
        settle(k, end, 0);
      }

      k = end;
    }

    // who gets in: each division's best first where winners do, then the rest
    inIt.fill(0);
    seeds.length = 0;

    if (byDivision) {
      const won = new Set<number>();

      for (const i of order) {
        const d = division[i] ?? null;

        if (d !== null && divisionIds.includes(d) && !won.has(d)) {
          won.add(d);
          inIt[i] = 1;
          titles[i]!++;
          seeds.push(i);
        }
      }

      let wild = input.playoffTeams - won.size;

      for (const i of order) {
        if (wild <= 0) {
          break;
        }

        if (!inIt[i]) {
          inIt[i] = 1;
          seeds.push(i);
          wild--;
        }
      }
    } else {
      order.slice(0, input.playoffTeams).forEach((i) => { inIt[i] = 1; seeds.push(i); });
    }

    if (rounds) {
      for (let k = 0; k < byeCount && k < seeds.length; k++) {
        byes[seeds[k]!]!++;
      }

      // the bracket by seed, a seed nobody holds being a bye
      let alive = slots.map((s) => seeds[s - 1] ?? -1);

      for (let r = 0; r < rounds; r++) {
        const on: number[] = [];

        for (let k = 0; k < alive.length; k += 2) {
          const a = alive[k]!;
          const b = alive[k + 1]!;
          // both scores drawn every time, byes too, so the stream stays in step
          const da = normal(playoffDice);
          const db = normal(playoffDice);
          const sa = a < 0 ? 0 : roundMean[r]![a]! + roundSd[r]![a]! * da;
          const sb = b < 0 ? 0 : roundMean[r]![b]! + roundSd[r]![b]! * db;

          on.push(b < 0 ? a : a < 0 ? b : sa >= sb ? a : b);
        }

        alive = on;
      }

      if (alive[0]! >= 0) {
        champions[alive[0]!]!++;
      }
    }

    for (let i = 0; i < n; i++) {
      made[i]! += inIt[i]!;
      winsSum[i]! += wins[i]!;
    }

    firsts[order[0]!]!++;

    if (me === undefined) {
      continue;
    }

    const mineIn = inIt[me] === 1;

    trail.forEach((won, w) => {
      ways[w]![won]! += 1;
      waysMade[w]![won]! += Number(mineIn);
    });

    if (iWon !== null) {
      if (iWon) {
        wonRuns++;
        wonMade += Number(mineIn);
      } else {
        lostRuns++;
        lostMade += Number(mineIn);
      }
    }
  }

  return {
    odds: owners.map((owner, i) => ({
      owner,
      playoffs: made[i]! / draws,
      first: firsts[i]! / draws,
      wins: winsSum[i]! / draws,
      ...(byDivision ? { division: titles[i]! / draws } : {}),
      ...(rounds ? { champion: champions[i]! / draws } : {}),
      ...(byeCount > 0 ? { bye: byes[i]! / draws } : {}),
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

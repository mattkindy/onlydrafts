/**
 * The play factors, counted against the exact state and widened only
 * when a question is asked of a thin one.
 *
 * Storing by bucket decides in advance what resolution every question
 * gets. Storing by state and widening on demand lets the goal line keep
 * its own numbers, where the counts are large, while fourth and
 * nineteen at the forty seven borrows from around it.
 */

import {
  emptyCell, keysAt, stateKey, widening,
  type Call, type PlayFactors, type PlayState, type StateCell,
} from "../model/playFactors.js";
import type { RunParts } from "./runParts.js";
import type { PlayLevel } from "./playLevel.js";
import { bandOf, type TargetDepth } from "./targetDepth.js";

export interface PlayRow {
  /** who had the ball and who was trying to stop them */
  offence: string;
  defence: string;
  down: number;
  toGo: number;
  yardline: number;
  /** this team's lead, and the clock, which move what a coach calls */
  margin: number;
  secondsLeft: number;
  call: Call;
  yards: number;
  touchdown: number;
  /** who had it, empty when the play is only being counted */
  player: string;
  /** and who threw it, empty on a carry or when nobody was credited */
  passer?: string;
  /** how far downfield it was thrown, absent on a carry */
  airYards?: number;
}

export interface FactorSettings {
  /** plays needed before a state speaks for itself */
  least: number;
  /**
   * And how many the call needs, which is fewer. A run rate is one
   * number and eighty plays place it within about six points; a
   * distribution of yards wants far more. Asking both for three
   * hundred meant no state ever had enough under its own clock and
   * score, so the call never moved with the game.
   */
  leastForCall: number;
  /** touches needed before a man's own share at a state is believed */
  leastForMan: number;
  /** plays needed before one side's own numbers are believed */
  leastForSide: number;
}

export const FACTOR_DEFAULTS: FactorSettings = {
  least: 300, leastForCall: 80, leastForMan: 40, leastForSide: 60,
};

/** what somebody managed over a set of plays, at whatever scope */
interface Rate {
  touches: number;
  yards: number;
  /** and how many of them went for twenty or more */
  long: number;
}

const emptyRate = (): Rate => ({ touches: 0, yards: 0, long: 0 });

const addTo = (into: Map<string, Rate>, key: string, yards: number): void => {
  const own = into.get(key) ?? emptyRate();
  own.touches++;
  own.yards += yards;
  if (yards >= 20) own.long++;
  into.set(key, own);
};

/** everything counted at one state, plus who touched it there */
interface Counted extends StateCell {
  byPlayer: Map<string, {
    touches: number; yards: number; scores: number;
    /** and how often he breaks a long one, which is his own and lasts */
    long: number;
  }>;
  /**
   * Where each gain came from, since a gain is cut off by the goal
   * line. A play from the forty one cannot make more than forty one
   * yards, so pooling it in with the forty five caps what a draw there
   * can produce and halves the long scores.
   */
  from: number[];
  /**
   * And the same again over the plays a player was named on.
   *
   * A tenth of passes are sacks, which nobody is credited with and
   * which average four and a third yards backwards. Comparing a
   * receiver's yards against a league average that includes them makes
   * every receiver look 21% better than he is.
   */
  named: Rate;
  /**
   * And the gains kept apart by how far downfield the throw went.
   *
   * A checkdown gains nothing a quarter of the time and makes seven
   * when it works; a shot past twenty-five gains nothing two thirds of
   * the time and makes thirty-nine. Drawing both from one pool gives
   * every receiver the same throw.
   */
  byDepth: Map<number, number[]>;
}

const emptyCounted = (): Counted =>
  ({
    ...emptyCell(), byPlayer: new Map(), from: [], named: emptyRate(),
    byDepth: new Map(),
  });

/**
 * Which depth this throw goes to, from what happens here tilted by how
 * this man is used.
 *
 * Taking his own mix straight would throw deep at the goal line
 * because that is what he does over a season. The situation says what
 * depths happen here and his leaning says which of them are his.
 */
const bandHere = (
  cell: Counted, leaning: number[], uniform: () => number,
): number => {
  const weights: number[] = [];
  let total = 0;

  for (let band = 0; band < leaning.length; band++) {
    const here = (cell.byDepth.get(band) ?? []).length;
    const weight = here * (leaning[band] ?? 1);
    weights.push(weight);
    total += weight;
  }

  if (total <= 0) {
    return 0;
  }

  let left = uniform() * total;

  for (let band = 0; band < weights.length; band++) {
    left -= weights[band]!;

    if (left <= 0) {
      return band;
    }
  }

  return weights.length - 1;
};

/**
 * The gains at one depth, borrowing from the bands beside it when
 * that one is thin.
 *
 * Falling back to every depth at this spot is what a thin band used to
 * do, and it quietly turned a deep throw into an average one: a shot
 * past twenty-five is worth thirty-nine yards when it works and the
 * pool of all throws is worth six. A band next door is much closer to
 * the truth than no band at all.
 */
const gainsAtDepth = (cell: Counted, band: number): number[] => {
  let found = [...(cell.byDepth.get(band) ?? [])];

  for (let step = 1; step < 6 && found.length < 40; step++) {
    for (const beside of [band - step, band + step]) {
      if (beside >= 0) {
        found = found.concat(cell.byDepth.get(beside) ?? []);
      }
    }
  }

  return found;
};

const countIn = (rate: Rate, yards: number): void => {
  rate.touches++;
  rate.yards += yards;
  if (yards >= 20) rate.long++;
};

/**
 * What share of his offence's work each man is expected to take.
 *
 * Left out, the factors divide the work by what each man did before,
 * which is the weakest way we have of guessing a share: .596 against
 * .747 for working it out from who he is competing with. Passed in,
 * that model sets how much a man gets and the history only says where
 * he gets it.
 */
export type ProjectedShares = Map<string, number>;

/**
 * What these two sides together do to a play, against what an average
 * pair does.
 *
 * The counts below ask each side on its own, so an offence that has
 * gained a lot and a defence that has given up little multiply
 * together as though neither had met the other. They also cannot see a
 * defence whose men have changed since those plays.
 */
export type Pairing = (offence: string, defence: string, call: Call) => number;

export type { RunParts } from "./runParts.js";

export type { PlayLevel } from "./playLevel.js";

export function fitPlayFactors(
  rows: PlayRow[],
  settings: FactorSettings = FACTOR_DEFAULTS,
  projected?: ProjectedShares,
  pairing?: Pairing,
  runParts?: RunParts,
  /**
   * One model for the level, with everybody on the play at once.
   * Given it, the per-man and per-side multipliers below stand down,
   * since it already knows all of them and how they bear on each
   * other.
   */
  playLevel?: PlayLevel,
  /**
   * The two things the joint fit found worth having: the men on that
   * defence this week, which moves a throw by 1.3 yards where a
   * franchise-level number moves it by a fraction, and the
   * quarterback, who did not exist here at all.
   */
  depth?: TargetDepth,
  people?: {
    defenceNow?: (defence: string, season: number, week: number, call: Call) => number;
    passing?: (receiver: string, passer: string) => number;
  },
): PlayFactors {
  const cells = new Map<string, Counted>();
  /**
   * The same counts again per offence and per defence.
   *
   * Every side was walked with the league's numbers, so two teams
   * differed only in who took the ball off them, and the model had no
   * skill on a particular game at all. A side that runs well keeps its
   * own numbers where it has enough plays, and a defence moves them by
   * how much it gives up against what everybody gives up.
   */
  const byOffence = new Map<string, Counted>();
  const byDefence = new Map<string, Counted>();
  /**
   * And each man over everything he did on a call, with the league
   * beside him for comparison.
   *
   * Asking for his forty touches inside one widened state never found
   * them. The widening stops when the state has three hundred plays,
   * and the busiest man in such a state has thirty. So every carry and
   * every catch came out at the league's yards and no player differed
   * from any other, which is most of why the model moved a team game
   * by one point where what happened moves by ten.
   */
  const byMan = new Map<string, Rate>();
  const leagueOn = new Map<string, Rate>();
  // how much of the ball each man took overall, so his usage at one
  // state can be read as a leaning rather than a level
  const overall = new Map<string, number>();
  let everyTouch = 0;

  for (const row of rows) {
    if (row.player) {
      overall.set(row.player, (overall.get(row.player) ?? 0) + 1);
      everyTouch++;
      addTo(byMan, `${row.player}|${row.call}`, row.yards);
      addTo(leagueOn, row.call, row.yards);
    }
  }

  for (const row of rows) {
    // Keyed by the call as well. A run and a pass from the same spot
    // gain differently, 4.5 yards against 6.1 with a far fatter tail,
    // and go to different men. Pooling them meant the call decided
    // nothing at all.
    const at = `${row.call}|` + stateKey(
      row.down, row.toGo, row.yardline, row.secondsLeft, row.margin,
    );
    // and the same play again under any clock and any score, so a thin
    // state can fall back to the spot itself
    const loose = `${row.call}|${Math.min(4, row.down)}|${Math.min(40, row.toGo)}` +
      `|${Math.min(99, row.yardline)}|any`;
    // and once more without the call, because how often a side runs has
    // to come from one cell counting both. Widening a run pool and a
    // pass pool separately until each has enough finds eighty of each
    // wherever it must, and the answer is fifty percent every time.
    const eitherWay = stateKey(
      row.down, row.toGo, row.yardline, row.secondsLeft, row.margin,
    );
    const eitherLoose =
      `${Math.min(4, row.down)}|${Math.min(40, row.toGo)}` +
      `|${Math.min(99, row.yardline)}|any`;
    const cell = cells.get(at) ?? emptyCounted();
    cell.plays++;
    if (row.call === "run") cell.runs++;
    cell.yards.push(row.yards);
    cell.from.push(row.yardline);
    cell.scores += row.touchdown;

    if (row.call === "pass" && row.airYards !== undefined) {
      const band = bandOf(row.airYards);
      cell.byDepth.set(band, [...(cell.byDepth.get(band) ?? []), row.yards]);
    }

    if (row.player) {
      countIn(cell.named, row.yards);
      const own = cell.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0, long: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;
      if (row.yards >= 20) own.long++;
      cell.byPlayer.set(row.player, own);
    }

    cells.set(at, cell);

    const anyTime = cells.get(loose) ?? emptyCounted();
    anyTime.plays++;
    if (row.call === "run") anyTime.runs++;
    anyTime.yards.push(row.yards);
    anyTime.from.push(row.yardline);
    anyTime.scores += row.touchdown;

    if (row.call === "pass" && row.airYards !== undefined) {
      const band = bandOf(row.airYards);
      anyTime.byDepth.set(band, [...(anyTime.byDepth.get(band) ?? []), row.yards]);
    }

    if (row.player) {
      countIn(anyTime.named, row.yards);
      const own = anyTime.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0, long: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;
      if (row.yards >= 20) own.long++;
      anyTime.byPlayer.set(row.player, own);
    }

    cells.set(loose, anyTime);

    for (const key of [eitherWay, eitherLoose]) {
      const both = cells.get(key) ?? emptyCounted();
      both.plays++;
      if (row.call === "run") both.runs++;
      cells.set(key, both);
    }

    for (const [into, who] of [
      [byOffence, row.offence], [byDefence, row.defence],
    ] as [Map<string, Counted>, string][]) {
      if (!who) {
        continue;
      }

      for (const key of [`${who}|${at}`, `${who}|${loose}`, `${who}|${eitherLoose}`]) {
        const side = into.get(key) ?? emptyCounted();
        side.plays++;
        if (row.call === "run") side.runs++;
        side.yards.push(row.yards);
        side.scores += row.touchdown;
        into.set(key, side);
      }
    }
  }

  /**
   * The states around this one, taken until there are enough plays.
   *
   * The clock and the score are held first, and if this spot cannot
   * answer for itself under them the whole thing starts again with them
   * let go. Carrying the tight counts into the loose pass would add the
   * any-time cells on top of them, and those contain the tight ones, so
   * the game situation would be swamped every time.
   */
  const gather = (
    state: PlayState, least: number, looseness: number, call?: Call,
  ) => {
    const pooled = emptyCounted();

    for (const spot of widening(state)) {
      if (spot.looseness !== looseness) {
        continue;
      }

      for (const at of keysAt(
        state.down, spot.toGo, spot.yardline,
        state.secondsLeft, state.margin, looseness,
      )) {
      const cell = cells.get(call ? `${call}|${at}` : at);

      if (!cell) {
        continue;
      }

      pooled.plays += cell.plays;
      pooled.runs += cell.runs;
      pooled.scores += cell.scores;
      pooled.yards = pooled.yards.concat(cell.yards);
      pooled.from = pooled.from.concat(cell.from);
      for (const [band, gains] of cell.byDepth) {
        pooled.byDepth.set(band, (pooled.byDepth.get(band) ?? []).concat(gains));
      }

      pooled.named.touches += cell.named.touches;
      pooled.named.yards += cell.named.yards;
      pooled.named.long += cell.named.long;

      for (const [player, own] of cell.byPlayer) {
        const already = pooled.byPlayer.get(player) ??
          { touches: 0, yards: 0, scores: 0, long: 0 };
        already.touches += own.touches;
        already.yards += own.yards;
        already.scores += own.scores;
        already.long += own.long;
        pooled.byPlayer.set(player, already);
      }

      }

      if (pooled.plays >= least) {
        break;
      }
    }

    return pooled;
  };

  /**
   * The same gathering over one side's own plays. Kept apart from the
   * league version so a thin team falls back to everybody rather than
   * quietly mixing the two.
   */
  const sideRemembered = new Map<string, Counted>();
  const forSide = (
    from: Map<string, Counted>, who: string, state: PlayState,
    least: number, call?: Call,
  ) => {
    const key = `${who}|${call ?? "both"}|${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}|${least}`;
    const already = sideRemembered.get(key);

    if (already) {
      return already;
    }

    let found = emptyCounted();

    for (const looseness of [0, 1, 2]) {
      const pooled = emptyCounted();

      for (const spot of widening(state)) {
        if (spot.looseness !== looseness) {
          continue;
        }

        for (const cellKey of keysAt(
          state.down, spot.toGo, spot.yardline,
          state.secondsLeft, state.margin, looseness,
        )) {
          const cell = from.get(`${who}|${call ? `${call}|${cellKey}` : cellKey}`);

          if (!cell) {
            continue;
          }

          pooled.plays += cell.plays;
          pooled.runs += cell.runs;
          pooled.scores += cell.scores;
          pooled.yards = pooled.yards.concat(cell.yards);
        }

        if (pooled.plays >= least) {
          break;
        }
      }

      found = pooled;

      if (found.plays >= least) {
        break;
      }
    }

    sideRemembered.set(key, found);
    return found;
  };

  const average = (cell: Counted) =>
    cell.plays === 0 ? 0 : cell.yards.reduce((a, b) => a + b, 0) / cell.plays;

  const remembered = new Map<string, Counted>();
  const at = (state: PlayState, least: number, call?: Call) => {
    const key = `${call ?? "both"}|${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}|${least}`;
    const already = remembered.get(key);

    if (already) {
      return already;
    }

    let found = gather(state, least, 0, call);

    for (const looseness of [1, 2]) {
      if (found.plays >= least) {
        break;
      }

      found = gather(state, least, looseness, call);
    }
    remembered.set(key, found);
    return found;
  };

  return {
    runs: (state, offence) => {
      const league = at(state, settings.leastForCall);
      const leagueRate = league.plays === 0 ? 0.45 : league.runs / league.plays;

      if (!offence) {
        return leagueRate;
      }

      // his own where he has run enough of them from here
      const own = forSide(byOffence, offence, state, settings.leastForSide);
      return own.plays >= settings.leastForSide
        ? own.runs / own.plays
        : leagueRate;
    },
    goesTo: (state, call, among) => {
      const cell = at(
        state, settings.leastForMan * Math.max(1, among.length), call,
      );
      const here = [...cell.byPlayer.values()].reduce((a, o) => a + o.touches, 0);
      const shares = new Map<string, number>();
      let total = 0;

      for (const player of among) {
        const own = cell.byPlayer.get(player);
        const touches = own ? own.touches : 0;

        if (!projected) {
          shares.set(player, touches);
          total += touches;
          continue;
        }

        // How much more of the work he takes here than he takes in
        // general. A man used on third down leans that way whatever his
        // overall share turns out to be next season.
        const hisOverall = (overall.get(player) ?? 0) / Math.max(1, everyTouch);
        const hisHere = here > 0 ? touches / here : 0;
        const leaning = hisOverall > 0 && hisHere > 0
          ? hisHere / hisOverall
          : 1;
        const weight = (projected.get(player) ?? 0) * leaning;
        shares.set(player, weight);
        total += weight;
      }

      if (total === 0) {
        for (const player of among) shares.set(player, 1 / among.length);
        return shares;
      }

      for (const [player, weight] of shares) shares.set(player, weight / total);

      return shares;
    },
    gains: (state, call, player, uniform, sides) => {
      const cell = at(state, settings.least, call);
      const own = cell.byPlayer.get(player);
      const pool = cell.yards;

      if (!pool.length) {
        return 4;
      }

      /**
       * Whether this is one of his long ones is decided first, from how
       * often he breaks them, and the yards are then drawn from that
       * end of the pool.
       *
       * Scaling every draw by what he averages gives a possession
       * receiver and a deep threat the same shape when they average the
       * same. Breaking a twenty runs from 1.5% of touches to 14.7%
       * across men, lasts from season to season at .755, and is mostly
       * not what his average already says, .684 of it surviving once
       * the average is taken out.
       */
      /**
       * On a throw, the man's own depth picks which pool.
       *
       * How far downfield he is thrown carries to the next season at
       * .877, so it is the surest thing we know about him, and it
       * settles how often the throw gains nothing as well as how much
       * it makes when it does.
       */
      const atDepth = depth && call === "pass" && player
        ? gainsAtDepth(cell, bandHere(cell, depth.leaningOf(player), uniform))
        : undefined;
      const drawFrom = atDepth && atDepth.length >= 20 ? atDepth : pool;
      const longOnes: number[] = [];
      const shortOnes: number[] = [];
      const wentNowhere: number[] = [];

      for (const gained of drawFrom) {
        if (gained <= 0) {
          wentNowhere.push(gained);
          continue;
        }

        (gained >= 20 ? longOnes : shortOnes).push(gained);
      }

      /**
       * Whether it went anywhere at all, decided before how far.
       *
       * A third of throws gain nothing because nobody caught them, and
       * that is most of what a good defence does. Multiplying a drawn
       * gain can never produce one, since nothing times anything is
       * nothing, so which end of the pool to draw from is asked first.
       */
      const wentNowhereHere = wentNowhere.length / Math.max(1, drawFrom.length);
      const stuffed = playLevel && sides
        ? Math.max(0, Math.min(0.95,
            wentNowhereHere * playLevel.stuffedBy(state, call, player, sides)))
        : wentNowhereHere;

      if (wentNowhere.length && uniform() < stuffed) {
        return wentNowhere[Math.floor(uniform() * wentNowhere.length)]!;
      }

      const gainful = longOnes.length + shortOnes.length;
      const leagueLong = longOnes.length / Math.max(1, gainful);
      /**
       * Him against the league, both measured over the same plays.
       *
       * At this state when he has been here enough, otherwise over
       * everything he did on this call. The two have to be compared at
       * the same scope: his season average against a goal line average
       * would make every man look twice as good near the line.
       */
      const wide = byMan.get(`${player}|${call}`);
      const atState = own && own.touches >= settings.leastForMan
        ? { his: own, league: cell.named }
        : undefined;
      const found = atState ?? (wide && wide.touches >= settings.leastForMan
        ? { his: wide, league: leagueOn.get(call) }
        : undefined);
      const hisLong = found?.league && found.league.touches > 0 && found.league.long > 0
        ? Math.max(0, Math.min(0.6,
            leagueLong * (found.his.long / found.his.touches) /
              (found.league.long / found.league.touches)))
        : leagueLong;
      const from = uniform() < hisLong && longOnes.length ? longOnes
        : shortOnes.length ? shortOnes : longOnes.length ? longOnes : pool;
      const drawn = from[Math.floor(uniform() * from.length)]!;

      if (!found?.league || drawn <= 0) {
        return drawn;
      }

      // and his level on top, against what everybody made over the
      // same plays, with the long ones taken out of it since the draw
      // above has already put them in
      const league = found.league.yards / Math.max(1, found.league.touches);
      const his = found.his.yards / Math.max(1, found.his.touches);
      const leagueLongRate = found.league.long / Math.max(1, found.league.touches);
      const hisLongRate = found.his.long / Math.max(1, found.his.touches);
      // and how far it went, now that whether it went anywhere has
      // already been settled above
      const level = playLevel && sides
        ? playLevel.levelFor(state, call, player, sides)
        : his / Math.max(0.1, league);
      const shape = leagueLongRate > 0 && hisLongRate > 0
        ? level * (leagueLongRate / hisLongRate) ** 0.5
        : level;

      const bent = drawn * Math.max(0.5, Math.min(1.8, shape));

      if (!sides || bent <= 0 || playLevel) {
        return bent;
      }

      let byPeople = 1;

      if (people?.defenceNow && sides.defence && sides.season && sides.week) {
        byPeople *= people.defenceNow(sides.defence, sides.season, sides.week, call);
      }

      if (people?.passing && call === "pass" && sides.passer) {
        byPeople *= people.passing(player, sides.passer);
      }

      if (byPeople !== 1) {
        return bent * byPeople;
      }

      if (pairing && sides.offence && sides.defence) {
        return bent * pairing(sides.offence, sides.defence, call);
      }

      // and what the two sides do to it, each against what everybody
      // does from here, held near one since a side is not that
      // different from the rest
      /**
       * A ratio needs far fewer plays than a distribution does, so the
       * sides are asked with a lower bar than the pool itself. Asking
       * for three hundred of one team's plays at one state meant the
       * answer was one every time and the teams never differed.
       */
      const leagueYards = average(cell);
      const held = (found: Counted) => {
        if (leagueYards <= 0 || found.plays < settings.leastForSide) {
          return 1;
        }

        return Math.max(0.8, Math.min(1.25, average(found) / leagueYards));
      };
      const theirs = sides.offence
        ? held(forSide(byOffence, sides.offence, state, settings.leastForSide, call))
        : 1;
      const against = sides.defence
        ? held(forSide(byDefence, sides.defence, state, settings.leastForSide, call))
        : 1;

      return bent * theirs * against;
    },
    scores: (state, call, gained) => {
      if (state.yardline - gained <= 0) {
        return 1;
      }

      const cell = at(state, settings.least, call);
      return cell.plays === 0 ? 0 : cell.scores / cell.plays;
    },
  };
}

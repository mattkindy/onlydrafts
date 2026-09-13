/**
 * What a pickup or a drop does to the game you are playing this week.
 *
 * The season side of the waiver page draws a whole year of weeks against a
 * typical opponent. This asks the narrower question the lineup page asks:
 * with this week's projections, the lineup you would set, and the team you
 * actually play, does the man start, who takes his seat if he goes, and how
 * often do you win the week either way.
 *
 * One set of draws serves both sides and every row. Where both men in a
 * seat had their week drawn off a ladder, the win chance is the conditional
 * estimator the lineup page uses; where either has no ladder both are
 * counted off the draws, so the two figures on a row are read the same way.
 */

import { factorsOf, type Mix } from "./copula.ts";
import { chanceWith, type Seat } from "./explain.ts";
import {
  bestLineupFor, CHOICE_DRAWS, lineFor, liveDraws, seatTakes, sideTotals,
  starterState, type Drawing, type GameState, type Lines, type Starter,
} from "./matchups.ts";
import type { Side } from "./providers.ts";
import type { Player } from "./scoring.ts";
import type { SlateRow } from "./slate.ts";
import { winChance } from "./winShare.ts";

export interface WeekDrop {
  /** the seat he is in this week, and nothing when he is on the bench */
  slot: string | null;
  /** who takes that seat once he is gone, and nobody when nobody can */
  heir: string | null;
  /** the points your lineup loses this week without him */
  takes: number;
  /** how often you win this week with him, and how often without him */
  before: number;
  after: number;
  costs: number;
}

export interface WeekAdd {
  /** the seat he would take this week, and nothing when he would not start */
  slot: string | null;
  /** the man he would push out of it */
  displaced: string | null;
  /** the points your lineup gains this week with him */
  brings: number;
  before: number;
  after: number;
  added: number;
}

export interface WeekNet {
  /** the man who goes, and nobody when there is a spot open for him */
  drop: string | null;
  before: number;
  after: number;
  net: number;
}

/** one man the page is pricing, and the man a spot for him would cost */
export interface WeekCandidate {
  p: Player;
  drop: Player | null;
}

export interface WeekRoom {
  /** your own side of this week's game, and the side across from it */
  side: Side;
  against: Side;
  slots: string[] | null | undefined;
  /** the week's projections, by the key a lineup uses for a man */
  rows: Map<string, SlateRow>;
  states: Map<string, GameState>;
  /** the board in this league's terms, for the men the week leaves out */
  lines: Lines;
  draws?: number;
}

export interface WeekPrices {
  /** who you play this week */
  opponent: string;
  /** how often you win it with the lineup the week page would set */
  odds: number;
  drops: Map<string, WeekDrop>;
  adds: Map<string, WeekAdd>;
  nets: Map<string, WeekNet>;
}

/** what the week knows about one man, drawn once and read many times */
interface Manned {
  key: string;
  position: string;
  /** what he puts up this week, draw by draw, what he has scored included */
  column: number[];
  /** how his week was drawn, where it came off a ladder */
  drawn: Drawing | null;
  /** his game has kicked off, so the league will not move him now */
  locked: boolean;
}

interface Filled {
  slot: string;
  man: Manned | null;
  /**
   * What the seat puts up, draw by draw. A starter nobody has a line on
   * still has points on the board, so the seat keeps a column of its own
   * rather than reading one off the man in it.
   */
  column: number[];
}

const mean = (its: number[]) =>
  its.reduce((sum, n) => sum + n, 0) / Math.max(1, its.length);

/** what every move is worth this week, for one roster against one opponent */
export function weekPricesFor(
  room: WeekRoom, candidates: WeekCandidate[],
): WeekPrices {
  const { side, against, slots, rows, states, lines } = room;
  const draws = room.draws ?? CHOICE_DRAWS;
  const best = bestLineupFor(side, against, slots, rows, states, draws, lines);
  const live = liveDraws(
    [
      ...side.starters, ...side.bench,
      ...candidates.map(({ p }) => ({ key: p.key, slot: p.position })),
      ...against.starters, ...against.bench,
    ],
    rows, states, draws, lines,
  );
  const theirs = sideTotals(against, rows, states, draws, live);

  const mannedOf = (man: Starter): Manned | null => {
    const line = lineFor(man, rows, lines);

    if (!line) {
      return null;
    }

    return {
      key: man.key,
      position: line.position,
      column: live.toCome(man.key).map((points) => points + (man.points ?? 0)),
      drawn: live.drawingOf(man.key),
      locked:
        (starterState(man, rows, states, lines)?.where ?? "pre") !== "pre",
    };
  };

  const mine = [...side.starters, ...side.bench]
    .map(mannedOf)
    .filter((man): man is Manned => man !== null);
  const byKey = new Map(mine.map((man) => [man.key, man]));
  const flat = () => new Array(draws).fill(0) as number[];
  const seats: Filled[] = best.starters.map((starter) => {
    const man = byKey.get(starter.key) ?? null;

    return {
      slot: starter.slot,
      man,
      column: man?.column ?? new Array(draws).fill(starter.points) as number[],
    };
  });
  const seated = new Set(
    seats.map((seat) => seat.man?.key).filter((key) => key !== undefined));

  const totalOf = (filled: Filled[]) =>
    Array.from({ length: draws }, (_, i) =>
      filled.reduce((sum, seat) => sum + seat.column[i]!, 0));
  const odds = winChance(totalOf(seats), theirs);

  const mixesOf = (men: (Manned | null)[]) => factorsOf(
    men.map((man) => man?.drawn?.mix)
      .filter((mix): mix is Mix => mix != null));
  const theirFactors = factorsOf(
    against.starters
      .map((man) => live.drawingOf(man.key)?.mix)
      .filter((mix): mix is Mix => mix != null));

  /** everything about the week except whoever is in one seat */
  const seatAt = (filled: Filled[], at: number): Seat => ({
    others: Array.from({ length: draws }, (_, i) =>
      filled.reduce(
        (sum, seat, k) => k === at ? sum : sum + seat.column[i]!, 0)),
    theirs,
    factors: live.factorAt,
    against: theirFactors,
    alongside: mixesOf(filled.filter((_, k) => k !== at).map((s) => s.man)),
  });

  const plainIn = (seat: Seat, man: Manned | null) =>
    winChance(
      seat.others.map((rest, i) => rest + (man?.column[i] ?? 0)), theirs);

  const pairIn = (
    seat: Seat, out: Manned | null, into: Manned | null,
  ): [number, number] => {
    if (out?.drawn && into?.drawn) {
      return [chanceWith(seat, out.drawn), chanceWith(seat, into.drawn)];
    }

    return [plainIn(seat, out), plainIn(seat, into)];
  };

  /**
   * Who you would put in a seat that has come open. The choice is made off
   * the drawn totals so every candidate for it is compared the same way,
   * even when the week has no ladder for one of them.
   */
  const heirFor = (filled: Filled[], at: number, bench: Manned[]) => {
    const seat = seatAt(filled, at);
    const slot = filled[at]!.slot;
    let heir: Manned | null = null;
    let most = plainIn(seat, null);

    for (const man of bench) {
      if (man.locked || !seatTakes(slot, man.position, slots)) {
        continue;
      }

      const chance = plainIn(seat, man);

      if (chance > most) {
        most = chance;
        heir = man;
      }
    }

    return { heir, seat };
  };

  /** the seat a newcomer does most good in, and what he is worth there */
  const bestSeatFor = (filled: Filled[], his: Manned) => {
    let found: {
      at: number; before: number; after: number; displaced: Manned | null;
    } | null = null;

    for (let at = 0; at < filled.length; at++) {
      const seat = filled[at]!;

      if (seat.man?.locked || !seatTakes(seat.slot, his.position, slots)) {
        continue;
      }

      const [before, after] = pairIn(seatAt(filled, at), seat.man, his);

      if (after - before > (found ? found.after - found.before : 0)) {
        found = { at, before, after, displaced: seat.man };
      }
    }

    return found;
  };

  const benchWithout = (key: string) =>
    mine.filter((man) => man.key !== key && !seated.has(man.key));

  const drops = new Map<string, WeekDrop>();

  for (const man of mine) {
    const at = seats.findIndex((seat) => seat.man?.key === man.key);

    if (at < 0) {
      drops.set(man.key, {
        slot: null, heir: null, takes: 0,
        before: odds, after: odds, costs: 0,
      });

      continue;
    }

    const { heir, seat } = heirFor(seats, at, benchWithout(man.key));
    const [before, after] = pairIn(seat, man, heir);

    drops.set(man.key, {
      slot: seats[at]!.slot,
      heir: heir?.key ?? null,
      takes: mean(man.column) - mean(heir?.column ?? []),
      before,
      after,
      costs: before - after,
    });
  }

  const adds = new Map<string, WeekAdd>();
  const newcomers = new Map<string, Manned>();

  for (const { p } of candidates) {
    const his = mannedOf({ key: p.key, slot: p.position });

    if (!his) {
      continue;
    }

    newcomers.set(p.key, his);
    const found = bestSeatFor(seats, his);

    if (!found) {
      adds.set(p.key, {
        slot: null, displaced: null, brings: 0,
        before: odds, after: odds, added: 0,
      });

      continue;
    }

    adds.set(p.key, {
      slot: seats[found.at]!.slot,
      displaced: found.displaced?.key ?? null,
      brings: mean(his.column) - mean(found.displaced?.column ?? []),
      before: found.before,
      after: found.after,
      added: found.after - found.before,
    });
  }

  /**
   * The whole move in this week's game: the man who goes comes out of the
   * lineup, the seat he leaves goes to whoever fills it best, and the
   * newcomer takes the seat he does most good in. Two seats change hands,
   * so the conditional estimator, which moves one man, has nothing to say
   * about it and the week is counted off the draws.
   */
  const wholeMove = (his: Manned, dropKey: string): WeekNet => {
    const filled = seats.map((seat) => ({ ...seat }));
    const bench = [...benchWithout(dropKey), his];
    const at = filled.findIndex((seat) => seat.man?.key === dropKey);

    if (at >= 0) {
      const { heir } = heirFor(filled, at, bench);
      filled[at] = {
        slot: filled[at]!.slot, man: heir, column: heir?.column ?? flat(),
      };
    }

    const found = filled.some((seat) => seat.man?.key === his.key)
      ? null
      : bestSeatFor(filled, his);

    if (found) {
      filled[found.at] = {
        slot: filled[found.at]!.slot, man: his, column: his.column,
      };
    }

    const after = winChance(totalOf(filled), theirs);

    return { drop: dropKey, before: odds, after, net: after - odds };
  };

  const nets = new Map<string, WeekNet>();

  for (const { p, drop } of candidates) {
    const his = newcomers.get(p.key);
    const add = adds.get(p.key);

    if (!his || !add) {
      continue;
    }

    nets.set(p.key, drop
      ? wholeMove(his, drop.key)
      : { drop: null, before: add.before, after: add.after, net: add.added });
  }

  return { opponent: against.owner, odds, drops, adds, nets };
}

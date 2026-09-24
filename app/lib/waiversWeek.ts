/**
 * What a pickup or a drop does to the game you are playing this week.
 *
 * The season side of the waiver page draws a whole year of weeks against a
 * typical opponent. This asks the narrower question the lineup page asks:
 * with this week's projections, the lineup you would set, and the team you
 * actually play, does the player start, who takes his slot if he goes, and how
 * often do you win the week either way.
 *
 * One set of draws serves both sides and every row. Where both players in a
 * slot had their week drawn off a ladder, the win chance is the conditional
 * estimator the lineup page uses; where either has no ladder both are
 * counted off the draws, so the two figures on a row are read the same way.
 */

import { factorsOf, type Mix } from "./copula.ts";
import { chanceWith, type Opening } from "./explain.ts";
import {
  bestLineupFor, CHOICE_DRAWS, lineFor, liveDraws, outscoreShare, slotTakesIn,
  sideTotals, starterState, type Drawing, type GameState, type Lines,
  type Starter,
} from "./matchups.ts";
import type { Side } from "./providers.ts";
import type { Player } from "./scoring.ts";
import type { SlateRow } from "./slate.ts";
import { winChance } from "./winShare.ts";

export interface WeekDrop {
  /** the slot he is in this week, and nothing when he is on the bench */
  slot: string | null;
  /** who takes that slot once he is gone, and nobody when nobody can */
  heir: string | null;
  /** the points your lineup loses this week without him */
  takes: number;
  /** how often you win this week with him, and how often without him */
  before: number;
  after: number;
  costs: number;
}

export interface WeekAdd {
  /** the slot he would take this week, and nothing when he would not start */
  slot: string | null;
  /** the player he would push out of it */
  displaced: string | null;
  /** the points your lineup gains this week with him */
  brings: number;
  /**
   * How often he outscores the player he pushes out, on his own. The win
   * figure already counts how he fits with the rest of the lineup and the
   * other side, so this says how much of it is the player himself.
   */
  outscores: number | null;
  before: number;
  after: number;
  added: number;
}

export interface WeekNet {
  /** the player who goes, and nobody when there is a spot open for him */
  drop: string | null;
  before: number;
  after: number;
  net: number;
}

/** one player the page is pricing, and the player a spot for him would cost */
export interface WeekCandidate {
  p: Player;
  drop: Player | null;
}

export interface WeekRoom {
  /** your own side of this week's game, and the side across from it */
  side: Side;
  against: Side;
  slots: string[] | null | undefined;
  /** the week's projections, by the key a lineup uses for a player */
  rows: Map<string, SlateRow>;
  states: Map<string, GameState>;
  /** the board in this league's terms, for the players the week leaves out */
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

/** what the week knows about one player, drawn once and read many times */
interface DrawnPlayer {
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
  player: DrawnPlayer | null;
  /**
   * What the slot puts up, draw by draw. A starter nobody has a line on
   * still has points on the board, so the slot keeps a column of its own
   * rather than reading one off the player in it.
   */
  column: number[];
}

const mean = (its: number[]) =>
  its.reduce((sum, n) => sum + n, 0) / Math.max(1, its.length);

/** what every move is worth this week, for one roster against one opponent */
export function weekPricesFor(
  room: WeekRoom, candidates: WeekCandidate[],
): WeekPrices {
  const { side, against, slots: slotNames, rows, states, lines } = room;
  const draws = room.draws ?? CHOICE_DRAWS;
  const best = bestLineupFor(
    side, against, slotNames, { rows, states, draws, lines });
  const live = liveDraws(
    [
      ...side.starters, ...side.bench,
      ...candidates.map(({ p }) => ({ key: p.key, slot: p.position })),
      ...against.starters, ...against.bench,
    ],
    rows, states, draws, lines,
  );
  const theirs = sideTotals(against, rows, states, draws, live);

  const drawnPlayerOf = (player: Starter): DrawnPlayer | null => {
    const line = lineFor(player, rows, lines);

    if (!line) {
      return null;
    }

    return {
      key: player.key,
      position: line.position,
      column: live.toCome(player.key).map((points) => points + (player.points ?? 0)),
      drawn: live.drawingOf(player.key),
      locked:
        (starterState(player, rows, states, lines)?.where ?? "pre") !== "pre",
    };
  };

  const mine = [...side.starters, ...side.bench]
    .map(drawnPlayerOf)
    .filter((player): player is DrawnPlayer => player !== null);
  const byKey = new Map(mine.map((player) => [player.key, player]));
  const flat = () => new Array(draws).fill(0) as number[];
  const lineup: Filled[] = best.starters.map((starter) => {
    const player = byKey.get(starter.key) ?? null;

    return {
      slot: starter.slot,
      player,
      column: player?.column ?? new Array(draws).fill(starter.points) as number[],
    };
  });
  const inLineup = new Set(
    lineup.map((slot) => slot.player?.key).filter((key) => key !== undefined));

  const totalOf = (filled: Filled[]) =>
    Array.from({ length: draws }, (_, i) =>
      filled.reduce((sum, slot) => sum + slot.column[i]!, 0));
  const odds = winChance(totalOf(lineup), theirs);

  const mixesOf = (players: (DrawnPlayer | null)[]) => factorsOf(
    players.map((player) => player?.drawn?.mix)
      .filter((mix): mix is Mix => mix != null));
  const theirFactors = factorsOf(
    against.starters
      .map((player) => live.drawingOf(player.key)?.mix)
      .filter((mix): mix is Mix => mix != null));

  /** everything about the week except whoever is in one slot */
  const openingAt = (filled: Filled[], at: number): Opening => ({
    others: Array.from({ length: draws }, (_, i) =>
      filled.reduce(
        (sum, slot, k) => k === at ? sum : sum + slot.column[i]!, 0)),
    theirs,
    factors: live.factorAt,
    against: theirFactors,
    alongside: mixesOf(filled.filter((_, k) => k !== at).map((s) => s.player)),
  });

  const plainIn = (opening: Opening, player: DrawnPlayer | null) =>
    winChance(
      opening.others.map((rest, i) => rest + (player?.column[i] ?? 0)), theirs);

  const pairIn = (
    opening: Opening, out: DrawnPlayer | null, into: DrawnPlayer | null,
  ): [number, number] => {
    if (out?.drawn && into?.drawn) {
      return [chanceWith(opening, out.drawn), chanceWith(opening, into.drawn)];
    }

    return [plainIn(opening, out), plainIn(opening, into)];
  };

  /**
   * Who you would put in a slot that has come open. The choice is made off
   * the drawn totals so every candidate for it is compared the same way,
   * even when the week has no ladder for one of them.
   */
  const heirFor = (filled: Filled[], at: number, bench: DrawnPlayer[]) => {
    const opening = openingAt(filled, at);
    const slot = filled[at]!.slot;
    let heir: DrawnPlayer | null = null;
    let most = plainIn(opening, null);

    for (const player of bench) {
      if (player.locked || !slotTakesIn(slot, player.position, slotNames)) {
        continue;
      }

      const chance = plainIn(opening, player);

      if (chance > most) {
        most = chance;
        heir = player;
      }
    }

    return { heir, opening };
  };

  /** the slot a newcomer does most good in, and what he is worth there */
  const bestSlotFor = (filled: Filled[], his: DrawnPlayer) => {
    let found: {
      at: number; before: number; after: number; displaced: DrawnPlayer | null;
    } | null = null;

    for (let at = 0; at < filled.length; at++) {
      const slot = filled[at]!;

      if (
        slot.player?.locked ||
        !slotTakesIn(slot.slot, his.position, slotNames)
      ) {
        continue;
      }

      const [before, after] = pairIn(openingAt(filled, at), slot.player, his);

      if (after - before > (found ? found.after - found.before : 0)) {
        found = { at, before, after, displaced: slot.player };
      }
    }

    return found;
  };

  const benchWithout = (key: string) =>
    mine.filter((player) => player.key !== key && !inLineup.has(player.key));

  const drops = new Map<string, WeekDrop>();

  for (const player of mine) {
    const at = lineup.findIndex((slot) => slot.player?.key === player.key);

    if (at < 0) {
      drops.set(player.key, {
        slot: null, heir: null, takes: 0,
        before: odds, after: odds, costs: 0,
      });

      continue;
    }

    const { heir, opening } = heirFor(lineup, at, benchWithout(player.key));
    const [before, after] = pairIn(opening, player, heir);

    drops.set(player.key, {
      slot: lineup[at]!.slot,
      heir: heir?.key ?? null,
      takes: mean(player.column) - mean(heir?.column ?? []),
      before,
      after,
      costs: before - after,
    });
  }

  const adds = new Map<string, WeekAdd>();
  const newcomers = new Map<string, DrawnPlayer>();

  for (const { p } of candidates) {
    const his = drawnPlayerOf({ key: p.key, slot: p.position });

    if (!his) {
      continue;
    }

    newcomers.set(p.key, his);
    const found = bestSlotFor(lineup, his);

    if (!found) {
      adds.set(p.key, {
        slot: null, displaced: null, brings: 0, outscores: null,
        before: odds, after: odds, added: 0,
      });

      continue;
    }

    adds.set(p.key, {
      slot: lineup[found.at]!.slot,
      displaced: found.displaced?.key ?? null,
      brings: mean(his.column) - mean(found.displaced?.column ?? []),
      outscores: found.displaced
        ? outscoreShare(his.column, found.displaced.column)
        : null,
      before: found.before,
      after: found.after,
      added: found.after - found.before,
    });
  }

  /**
   * The whole move in this week's game: the player who goes comes out of the
   * lineup, the slot he leaves goes to whoever fills it best, and the
   * newcomer takes the slot he does most good in. Two slots change hands,
   * so the conditional estimator, which moves one player, has nothing to say
   * about it and the week is counted off the draws.
   */
  const wholeMove = (his: DrawnPlayer, dropKey: string): WeekNet => {
    const filled = lineup.map((slot) => ({ ...slot }));
    const bench = [...benchWithout(dropKey), his];
    const at = filled.findIndex((slot) => slot.player?.key === dropKey);

    if (at >= 0) {
      const { heir } = heirFor(filled, at, bench);
      filled[at] = {
        slot: filled[at]!.slot, player: heir, column: heir?.column ?? flat(),
      };
    }

    const found = filled.some((slot) => slot.player?.key === his.key)
      ? null
      : bestSlotFor(filled, his);

    if (found) {
      filled[found.at] = {
        slot: filled[found.at]!.slot, player: his, column: his.column,
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

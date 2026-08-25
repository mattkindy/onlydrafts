/**
 * Next season in yards and catches rather than in points.
 *
 * The season regression predicts fantasy points, so it has to know a
 * league's rules before it can say anything, and a projection made
 * for one league is wrong for the next. This fits the same shape of
 * model once per part of a stat line, so what comes out is a player's
 * afternoon and whoever reads it applies their own scoring.
 *
 * Each part is predicted as a ratio to what he did last season, the
 * way the points model does it, since a receiver who caught four a
 * game is the best guide to how many he catches next year.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";
import { fitGbm, predictGbm, type GbmModel } from "../backtest/gbm.js";
import { PART_NAMES, type StatParts } from "./seasonSummary.js";
import {
  seasonRidgeRow, seasonGbmRow, type SeasonExample,
} from "./seasonModel.js";

export interface OnePart {
  ridge: number[];
  trees: GbmModel;
}

export type PartsFit = Record<keyof StatParts, OnePart>;

/** what he did last season, with two seasons blended when both exist */
export function partBefore(
  example: SeasonExample, part: keyof StatParts, weight = 0.25,
): number {
  const last = example.prevParts?.[part] ?? 0;
  const before = example.prev2Parts?.[part];

  if (before === undefined) {
    return last;
  }

  return (1 - weight) * last + weight * before;
}

/**
 * A man's floor at each part, for when he has no history to scale.
 *
 * A rookie and a man returning from a lost season both come in at
 * nothing, and a ratio to nothing is nothing forever, so the position
 * he plays supplies the starting point.
 */
export function partsByPosition(
  examples: SeasonExample[],
): Map<string, StatParts> {
  const totals = new Map<string, { parts: StatParts; men: number }>();

  for (const e of examples) {
    if (!e.actualParts) {
      continue;
    }

    const seen = totals.get(e.position) ??
      { parts: blankParts(), men: 0 };

    for (const part of PART_NAMES) {
      seen.parts[part] += e.actualParts[part];
    }

    seen.men++;
    totals.set(e.position, seen);
  }

  const out = new Map<string, StatParts>();

  for (const [position, seen] of totals) {
    const mean = blankParts();

    for (const part of PART_NAMES) {
      mean[part] = seen.parts[part] / Math.max(1, seen.men);
    }

    out.set(position, mean);
  }

  return out;
}

export const blankParts = (): StatParts => ({
  passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0,
  passAtt: 0, passCmp: 0, carries: 0, targets: 0,
});

/**
 * A ridge and a small forest per part, both on the log ratio to what
 * he did before, averaged the way the points model averages its two.
 */
export function fitPartsModel(examples: SeasonExample[]): PartsFit {
  const fit = {} as PartsFit;

  for (const part of PART_NAMES) {
    const usable = examples.filter((e) =>
      e.actualParts !== undefined && partBefore(e, part) > 0.2);
    const y = usable.map((e) =>
      Math.log(Math.min(Math.max(
        e.actualParts![part] / partBefore(e, part), 0.2,
      ), 3)));
    fit[part] = {
      ridge: fitRidge(usable.map(seasonRidgeRow), y, 5),
      // the same forest the points model grows
      trees: fitGbm(
        usable.map(seasonGbmRow), y,
        { trees: 200, depth: 3, rate: 0.05, minLeaf: 40 },
      ),
    };
  }

  return fit;
}

/**
 * What he does in a game next season, part by part.
 *
 * A man with a history is his own last season moved by the model. One
 * without enough to scale falls back to what his position does, since
 * the ratio has nothing to work on.
 */
export function predictParts(
  fit: PartsFit,
  example: SeasonExample,
  byPosition: Map<string, StatParts>,
): StatParts {
  const out = blankParts();
  const floor = byPosition.get(example.position) ?? blankParts();

  for (const part of PART_NAMES) {
    const before = partBefore(example, part);

    if (before <= 0.2) {
      // no history to move, so he starts from what his position does and
      // the market's read on him scales it
      const priced = example.adp ? Math.min(2, 60 / example.adp) : 0.35;
      out[part] = floor[part] * priced;
      continue;
    }

    const ratio = Math.exp((
      predictRidge(fit[part].ridge, seasonRidgeRow(example)) +
      predictGbm(fit[part].trees, seasonGbmRow(example))
    ) / 2);
    out[part] = before * Math.min(3, Math.max(0.2, ratio));
  }

  return out;
}

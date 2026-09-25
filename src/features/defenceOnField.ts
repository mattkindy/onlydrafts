/**
 * A defence as the players on the field, week by week.
 *
 * Asking what a side has given up treats a defence as a franchise, and
 * a tree given that feature spent 1.4% of its splits on it. The eleven
 * change: somebody is hurt, somebody was signed, and the number a
 * franchise carries from last season describes a group that has partly
 * gone.
 *
 * So fit every player's effect on the yards from who was out there, the
 * way adjusted plus-minus does, then describe a week's defence as the
 * players who actually played it.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { splitLine } from "../data/csv.js";
import { ON_FIELD_CSV } from "../data/onField.js";
import { fitPlusMinus, type Snap } from "../model/plusMinus.js";

export interface DefenceOnField {
  /** what the players who played this week are worth, in yards a play */
  weekOf: (season: number, week: number, defence: string) => number | undefined;
  /** how many players the fit could say anything about */
  knownPlayers: number;
  weeks: number;
}

interface OnFieldRequest {
  /** the seasons the effects are learned from */
  learn: number[];
  /** and the ones whose weekly line-ups get described */
  describe: number[];
  /** snaps a player needs before his own effect is used */
  leastSnaps?: number;
  penalty?: number;
}

export async function buildDefenceOnField(
  request: OnFieldRequest,
): Promise<DefenceOnField> {
  const leastSnaps = request.leastSnaps ?? 200;
  const snaps: Snap[] = [];
  /** `${season}|${week}|${team}` -> how many snaps each player played */
  const played = new Map<string, Map<string, number>>();
  const reader = createInterface({
    input: createReadStream(ON_FIELD_CSV),
  });
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      header.forEach((name, i) => { at[name] = i; });
      continue;
    }

    const c = splitLine(line);
    const season = Number(c[at["season"]!]);
    const ids = (text: string) => text.split(";").filter(Boolean);
    const defenceOn = ids(c[at["defenceOn"]!] ?? "");

    if (request.learn.includes(season)) {
      snaps.push({
        forIt: ids(c[at["offenceOn"]!] ?? ""),
        against: defenceOn,
        outcome: Number(c[at["yards"]!]) || 0,
      });
    }

    if (request.describe.includes(season)) {
      const key = `${season}|${c[at["week"]!]}|${c[at["defense"]!]}`;
      const own = played.get(key) ?? new Map<string, number>();

      for (const id of defenceOn) {
        own.set(id, (own.get(id) ?? 0) + 1);
      }

      played.set(key, own);
    }
  }

  const fitted = fitPlusMinus(snaps, request.penalty ?? 400);
  const weekly = new Map<string, number>();

  for (const [key, players] of played) {
    let snapsHere = 0;
    let total = 0;

    for (const [id, count] of players) {
      if ((fitted.snaps.get(id) ?? 0) < leastSnaps) {
        continue;
      }

      snapsHere += count;
      total += count * (fitted.effects.get(id) ?? 0);
    }

    if (snapsHere > 0) {
      weekly.set(key, total / snapsHere);
    }
  }

  return {
    knownPlayers: [...fitted.snaps.values()].filter((n) => n >= leastSnaps).length,
    weeks: weekly.size,
    weekOf: (season, week, defence) =>
      weekly.get(`${season}|${week}|${defence}`),
  };
}

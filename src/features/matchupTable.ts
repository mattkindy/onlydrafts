/**
 * A multiplier per pairing of sides, read off the interaction network.
 *
 * The walk bends a play by how many yards each side has managed at
 * that state, one side at a time. Two sides that never met come out
 * multiplied together as though they had, and a defence whose men have
 * changed is still judged on last year's numbers. The network reads both
 * sides from the players on the field, which is what it was built for
 * and where it beat the pooled version, .618 against .579.
 *
 * Every pairing is worked out once, before the walk starts, because
 * the pooled description of a side does not change play to play.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { splitLine } from "../data/csv.js";
import { RAW_DIR } from "../data/nflverse.js";
import { buildPlayerVectors, ATTRIBUTES } from "./playerVector.js";
import { matchup, type AgainstSettings } from "./defenceStrength.js";
import {
  INTERACTION_DEFAULTS, fitInteractionNet, type Described,
} from "../model/interactionNet.js";
import type { Call } from "../model/playFactors.js";

export interface MatchupRequest {
  /** the seasons the network learns the pairing from */
  learn: number[];
  /** the season whose sides are being described and walked */
  scoreOn: number;
  /** how far a pairing may move a play */
  settings?: AgainstSettings;
}

/** the state the network is asked about, which is a first and ten */
const stateOf = (run: boolean) =>
  Float64Array.from([1, 0, 0, 0, 1.0, 0.6, 0, 0, run ? 1 : 0]);

function pooled(rows: Float64Array[]): Float64Array {
  const out = new Float64Array(ATTRIBUTES.length);

  for (const row of rows) {
    for (let i = 0; i < out.length; i++) {
      out[i] = out[i]! + row[i]!;
    }
  }

  for (let i = 0; i < out.length; i++) {
    out[i] = out[i]! / Math.max(1, rows.length);
  }

  return out;
}

export interface MatchupTable {
  /** what these two do to a play of this kind */
  bend: (offence: string, defence: string, call: Call) => number;
  /** the sides it could describe, so a caller can say what it missed */
  sides: string[];
}

export async function buildMatchupTable(
  request: MatchupRequest,
): Promise<MatchupTable> {
  const vectors = new Map<string, Float64Array>();

  for (const season of [...request.learn, request.scoreOn]) {
    for (const [id, man] of await buildPlayerVectors(season - 1)) {
      vectors.set(`${season}|${id}`, man.values);
    }
  }

  const averageOf = (ids: string[], season: number) => {
    const out = new Float64Array(ATTRIBUTES.length);
    let known = 0;

    for (const id of ids) {
      const man = vectors.get(`${season}|${id}`);

      if (!man) {
        continue;
      }

      known++;

      for (let i = 0; i < out.length; i++) {
        out[i] = out[i]! + man[i]!;
      }
    }

    if (known > 1) {
      for (let i = 0; i < out.length; i++) {
        out[i] = out[i]! / known;
      }
    }

    return out;
  };

  const learn: { on: Described[]; yards: number }[] = [];
  const seen = new Map<string, { offence: Float64Array[]; defence: Float64Array[] }>();
  const reader = createInterface({
    input: createReadStream(join(RAW_DIR, "onField.csv")),
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
    const offence = averageOf(ids(c[at["offenceOn"]!] ?? ""), season);
    const defence = averageOf(ids(c[at["defenceOn"]!] ?? ""), season);

    if (request.learn.includes(season)) {
      learn.push({
        yards: Number(c[at["yards"]!]) || 0,
        on: [
          { kind: "offence", values: offence },
          { kind: "defence", values: defence },
          { kind: "situation", values: stateOf(c[at["playType"]!] === "run") },
        ],
      });
    }

    if (season === request.scoreOn) {
      for (const [team, which, values] of [
        [c[at["offense"]!] ?? "", "offence", offence],
        [c[at["defense"]!] ?? "", "defence", defence],
      ] as [string, "offence" | "defence", Float64Array][]) {
        const own = seen.get(team) ?? { offence: [], defence: [] };
        own[which].push(values);
        seen.set(team, own);
      }
    }
  }

  const net = fitInteractionNet(
    learn.map((s) => s.on),
    [{ name: "yards", of: (i: number) => learn[i]!.yards }],
    { ...INTERACTION_DEFAULTS, passes: 6 },
  );
  const averageOffence = pooled(learn.map((s) => s.on[0]!.values));
  const averageDefence = pooled(learn.map((s) => s.on[1]!.values));
  const describes = new Map<string, { offence: Float64Array; defence: Float64Array }>();

  for (const [team, rows] of seen) {
    describes.set(team, {
      offence: pooled(rows.offence), defence: pooled(rows.defence),
    });
  }

  const worked = new Map<string, { run: number; pass: number }>();

  return {
    sides: [...describes.keys()].sort(),
    bend: (offence, defence, call) => {
      const them = describes.get(offence);
      const they = describes.get(defence);

      if (!them || !they) {
        return 1;
      }

      const key = `${offence}|${defence}`;
      const already = worked.get(key) ?? matchup(
        net, them.offence, they.defence,
        averageOffence, averageDefence, stateOf, request.settings,
      );
      worked.set(key, already);

      return call === "run" ? already.run : already.pass;
    },
  };
}

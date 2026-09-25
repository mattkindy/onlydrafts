/**
 * A multiplier per pairing of sides, read off the interaction network.
 *
 * The walk bends a play by how many yards each side has managed at
 * that state, one side at a time. Two sides that never met come out
 * multiplied together as though they had, and a defence whose players have
 * changed is still judged on last year's numbers. The network reads both
 * sides from the players on the field, and beat the pooled version there,
 * .618 against .579.
 *
 * A side is described only from what was known before the walked week:
 * who took the field for it in the weeks already played, or its roster
 * before it has played. Every pairing is worked out once, before the walk.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { splitLine } from "../data/csv.js";
import { ON_FIELD_CSV as ON_FIELD } from "../data/onField.js";
import { buildPlayerVectors, ATTRIBUTES } from "./playerVector.js";
import { matchup, type AgainstSettings } from "./defenceStrength.js";
import {
  INTERACTION_DEFAULTS, fitInteractionNet, type Described, type InteractionNet,
} from "../model/interactionNet.js";
import type { Call } from "../model/playFactors.js";

interface MatchupRequest {
  /** the seasons the network learns the pairing from */
  learn: number[];
  /** the season whose sides are being described and walked */
  scoreOn: number;
  /**
   * The week being walked, whose own plays and later ones are not looked
   * at. Left out for the August world, which knows only the roster.
   */
  week?: number;
  /** who is on each side, for describing a side that has not played yet */
  cast?: Map<string, { playerId: string }[]>;
  /** how far a pairing may move a play */
  settings?: AgainstSettings;
  /**
   * Where to keep the answer, since fitting the network is minutes and
   * every side against every other is two thousand numbers. Several
   * runs of the same job would otherwise each fit their own copy.
   */
  keptAt?: string;
}

const KEPT = join(import.meta.dirname, "..", "..", "data", "kept");

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

interface MatchupTable {
  /** what these two do to a play of this kind */
  bend: (offence: string, defence: string, call: Call) => number;
  /** the sides it could describe, so a caller can say what it missed */
  sides: string[];
}

/** every pairing worked out, which is all the walk ever asks for */
interface Kept {
  sides: string[];
  /** `${offence}|${defence}` to what it does to a carry and a throw */
  bends: [string, [number, number]][];
}

const asTable = (kept: Kept): MatchupTable => {
  const bends = new Map(kept.bends);

  return {
    sides: kept.sides,
    bend: (offence, defence, call) => {
      const both = bends.get(`${offence}|${defence}`);

      if (!both) {
        return 1;
      }

      return call === "run" ? both[0] : both[1];
    },
  };
};

/**
 * Every row of the on-field file, split, with the header's columns by
 * name. The file is only published once a season is over.
 */
async function eachOnField(
  visit: (c: string[], at: Record<string, number>) => void,
): Promise<void> {
  const reader = createInterface({ input: createReadStream(ON_FIELD) });
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      header.forEach((name, i) => { at[name] = i; });
      continue;
    }

    visit(splitLine(line), at);
  }
}

const idsIn = (text: string) => text.split(";").filter(Boolean);

interface OnFieldReach {
  /**
   * The latest season and week on the file. It goes into the name of
   * anything kept from the file, so a table worked out before a season's
   * plays were published is not read back once they are.
   */
  reaches: string;
  /** the first week each season has on the file */
  opens: Map<number, number>;
}

async function surveyOnField(): Promise<OnFieldReach> {
  let season = 0;
  let week = 0;
  const opens = new Map<number, number>();

  await eachOnField((c, at) => {
    const s = Number(c[at["season"]!]);
    const w = Number(c[at["week"]!]);
    opens.set(s, Math.min(opens.get(s) ?? w, w));

    if (s > season || (s === season && w > week)) {
      season = s;
      week = w;
    }
  }).catch(() => undefined);

  return { reaches: `${season}w${week}`, opens };
}

type Vectors = Map<string, Float64Array>;

/** each player as the season before this one describes him */
async function vectorsFor(season: number): Promise<Vectors> {
  const out: Vectors = new Map();

  for (const [id, player] of await buildPlayerVectors(season - 1)) {
    out.set(id, player.values);
  }

  return out;
}

/** the players on one side of a snap, averaged, the way the network was taught */
function averageOf(ids: string[], vectors: Vectors): Float64Array {
  const out = new Float64Array(ATTRIBUTES.length);
  let known = 0;

  for (const id of ids) {
    const player = vectors.get(id);

    if (!player) {
      continue;
    }

    known++;

    for (let i = 0; i < out.length; i++) {
      out[i] = out[i]! + player[i]!;
    }
  }

  if (known > 1) {
    for (let i = 0; i < out.length; i++) {
      out[i] = out[i]! / known;
    }
  }

  return out;
}

interface Fitted {
  net: InteractionNet;
  averageOffence: Float64Array;
  averageDefence: Float64Array;
}

interface KeptNet {
  kinds: string[];
  project: [string, number[][]][];
  toHidden: number[][];
  hiddenBias: number[];
  heads: [string, { weights: number[]; bias: number }][];
  scaling: [string, { centre: number; spread: number }][];
  settings: InteractionNet["settings"];
  averageOffence: number[];
  averageDefence: number[];
}

export const flatNet = ({ net, averageOffence, averageDefence }: Fitted): KeptNet => ({
  kinds: net.kinds,
  project: [...net.project].map(([kind, rows]) => [kind, rows.map((r) => [...r])]),
  toHidden: net.toHidden.map((r) => [...r]),
  hiddenBias: [...net.hiddenBias],
  heads: [...net.heads].map(([task, head]) =>
    [task, { weights: [...head.weights], bias: head.bias }]),
  scaling: [...net.scaling],
  settings: net.settings,
  averageOffence: [...averageOffence],
  averageDefence: [...averageDefence],
});

export const raiseNet = (kept: KeptNet): Fitted => ({
  net: {
    kinds: kept.kinds,
    project: new Map(kept.project.map(([kind, rows]) =>
      [kind, rows.map((r) => Float64Array.from(r))])),
    toHidden: kept.toHidden.map((r) => Float64Array.from(r)),
    hiddenBias: Float64Array.from(kept.hiddenBias),
    heads: new Map(kept.heads.map(([task, head]) =>
      [task, { weights: Float64Array.from(head.weights), bias: head.bias }])),
    scaling: new Map(kept.scaling),
    settings: kept.settings,
  },
  averageOffence: Float64Array.from(kept.averageOffence),
  averageDefence: Float64Array.from(kept.averageDefence),
});

/**
 * The network over the learn seasons, kept on disk apart from the tables.
 * It does not depend on the walked week, and every week of a season asks
 * for its own table.
 */
async function fittedNet(learn: number[], reaches: string): Promise<Fitted> {
  const keptAt = join(KEPT, `matchup-net-${learn.join("-")}-${reaches}.json`);
  const already = await readFile(keptAt, "utf8").catch(() => "");

  if (already) {
    return raiseNet(JSON.parse(already) as KeptNet);
  }

  const vectors = new Map<number, Vectors>();

  for (const season of learn) {
    vectors.set(season, await vectorsFor(season));
  }

  const plays: { on: Described[]; yards: number }[] = [];

  await eachOnField((c, at) => {
    const own = vectors.get(Number(c[at["season"]!]));

    if (!own) {
      return;
    }

    plays.push({
      yards: Number(c[at["yards"]!]) || 0,
      on: [
        { kind: "offence", values: averageOf(idsIn(c[at["offenceOn"]!] ?? ""), own) },
        { kind: "defence", values: averageOf(idsIn(c[at["defenceOn"]!] ?? ""), own) },
        { kind: "situation", values: stateOf(c[at["playType"]!] === "run") },
      ],
    });
  });

  const fitted: Fitted = {
    net: fitInteractionNet(
      plays.map((s) => s.on),
      [{ name: "yards", of: (i: number) => plays[i]!.yards }],
      { ...INTERACTION_DEFAULTS, passes: 6 },
    ),
    averageOffence: pooled(plays.map((s) => s.on[0]!.values)),
    averageDefence: pooled(plays.map((s) => s.on[1]!.values)),
  };
  await mkdir(KEPT, { recursive: true }).catch(() => undefined);
  await writeFile(keptAt, JSON.stringify(flatNet(fitted))).catch(() => undefined);

  return fitted;
}

type Sides = Map<string, { offence: Float64Array; defence: Float64Array }>;

/** each side as it lined up in the weeks of the scored season before this one */
async function sidesFromPlays(request: MatchupRequest): Promise<Sides> {
  const vectors = await vectorsFor(request.scoreOn);
  const before = request.week ?? 1;
  const seen = new Map<string, { offence: Float64Array[]; defence: Float64Array[] }>();

  await eachOnField((c, at) => {
    if (Number(c[at["season"]!]) !== request.scoreOn ||
        Number(c[at["week"]!]) >= before) {
      return;
    }

    for (const [team, which, column] of [
      [c[at["offense"]!] ?? "", "offence", "offenceOn"],
      [c[at["defense"]!] ?? "", "defence", "defenceOn"],
    ] as [string, "offence" | "defence", string][]) {
      const own = seen.get(team) ?? { offence: [], defence: [] };
      own[which].push(averageOf(idsIn(c[at[column]!] ?? ""), vectors));
      seen.set(team, own);
    }
  });

  const sides: Sides = new Map();

  for (const [team, rows] of seen) {
    sides.set(team, { offence: pooled(rows.offence), defence: pooled(rows.defence) });
  }

  return sides;
}

/**
 * Each side as its roster, every player counted by how many snaps he took
 * on that side of the ball last season. Averaging players over snaps is
 * what averaging snaps over players comes to, so this lands on the same
 * scale as a side described from its plays.
 */
async function sidesFromCast(request: MatchupRequest): Promise<Sides> {
  const vectors = await vectorsFor(request.scoreOn);
  const snaps = { offence: new Map<string, number>(), defence: new Map<string, number>() };

  await eachOnField((c, at) => {
    if (Number(c[at["season"]!]) !== request.scoreOn - 1) {
      return;
    }

    for (const [which, column] of [
      ["offence", "offenceOn"], ["defence", "defenceOn"],
    ] as ["offence" | "defence", string][]) {
      for (const id of idsIn(c[at[column]!] ?? "")) {
        snaps[which].set(id, (snaps[which].get(id) ?? 0) + 1);
      }
    }
  });

  const weighted = (players: { playerId: string }[], counts: Map<string, number>) => {
    const out = new Float64Array(ATTRIBUTES.length);
    let total = 0;

    for (const { playerId } of players) {
      const player = vectors.get(playerId);
      const n = counts.get(playerId) ?? 0;

      if (!player || n === 0) {
        continue;
      }

      total += n;

      for (let i = 0; i < out.length; i++) {
        out[i] = out[i]! + n * player[i]!;
      }
    }

    return total > 0 ? out.map((v) => v / total) : undefined;
  };
  const sides: Sides = new Map();

  for (const [team, players] of request.cast ?? []) {
    const offence = weighted(players, snaps.offence);
    const defence = weighted(players, snaps.defence);

    if (offence && defence) {
      sides.set(team, { offence, defence });
    }
  }

  return sides;
}

/**
 * Sides described from their rosters, moved so that their average is the
 * league's. The roster leaves out rookies and anyone who did not play last
 * season, and without this every pairing would lean the same way for it.
 */
function centred(sides: Sides, fitted: Fitted): Sides {
  const offence = pooled([...sides.values()].map((s) => s.offence));
  const defence = pooled([...sides.values()].map((s) => s.defence));
  const out: Sides = new Map();

  for (const [team, side] of sides) {
    out.set(team, {
      offence: side.offence.map((v, i) => v - offence[i]! + fitted.averageOffence[i]!),
      defence: side.defence.map((v, i) => v - defence[i]! + fitted.averageDefence[i]!),
    });
  }

  return out;
}

type Source = "plays" | "cast";

/** plays when the scored season has any before the walked week, the roster otherwise */
export function describedFrom(
  request: Pick<MatchupRequest, "scoreOn" | "week">,
  opens: Map<number, number>,
): Source {
  const first = opens.get(request.scoreOn);

  if (request.week !== undefined && first !== undefined && first < request.week) {
    return "plays";
  }

  return "cast";
}

const castStamp = (cast: MatchupRequest["cast"]) =>
  createHash("sha1")
    .update([...(cast ?? [])]
      .flatMap(([team, players]) => players.map((p) => `${team}:${p.playerId}`))
      .sort()
      .join(","))
    .digest("hex")
    .slice(0, 12);

const DESCRIBE: Record<Source, {
  /** what the table depends on beyond the learn seasons and the file */
  stamp: (request: MatchupRequest) => string;
  sides: (request: MatchupRequest, fit: () => Promise<Fitted>) => Promise<Sides>;
}> = {
  plays: {
    stamp: (request) => `before${request.week}`,
    sides: (request) => sidesFromPlays(request),
  },
  cast: {
    stamp: (request) => `cast${castStamp(request.cast)}`,
    sides: async (request, fit) => {
      const sides = await sidesFromCast(request);

      if (sides.size === 0) {
        return sides;
      }

      return centred(sides, await fit());
    },
  },
};

export async function buildMatchupTable(
  request: MatchupRequest,
): Promise<MatchupTable> {
  const { reaches, opens } = await surveyOnField();
  const source = DESCRIBE[describedFrom(request, opens)];
  const keptAt = request.keptAt ?? join(
    KEPT,
    `matchup-${request.learn.join("-")}-${request.scoreOn}-` +
      `${source.stamp(request)}-${reaches}-` +
      `${(request.settings ?? { most: 0.2 }).most}.json`,
  );
  const already = await readFile(keptAt, "utf8").catch(() => "");

  if (already) {
    return asTable(JSON.parse(already) as Kept);
  }

  let fitting: Promise<Fitted> | undefined;
  const fit = () => (fitting ??= fittedNet(request.learn, reaches));
  const describes = await source.sides(request, fit);

  // a table with no sides would pass for one where every pairing is even
  if (describes.size === 0) {
    return asTable({ sides: [], bends: [] });
  }

  const { net, averageOffence, averageDefence } = await fit();
  // every pairing at once, so it can be written down and read back
  const sides = [...describes.keys()].sort();
  const bends: [string, [number, number]][] = [];

  for (const offence of sides) {
    for (const defence of sides) {
      const bent = matchup(
        net, describes.get(offence)!.offence, describes.get(defence)!.defence,
        averageOffence, averageDefence, stateOf, request.settings,
      );
      bends.push([`${offence}|${defence}`, [bent.run, bent.pass]]);
    }
  }

  const kept: Kept = { sides, bends };
  await mkdir(join(keptAt, ".."), { recursive: true }).catch(() => undefined);
  await writeFile(keptAt, JSON.stringify(kept)).catch(() => undefined);

  return asTable(kept);
}

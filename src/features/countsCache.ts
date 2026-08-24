/**
 * The counting pass kept on disk, one file per season boundary.
 *
 * Counting 141 thousand rows takes half a minute and eight shares of
 * one job each did it to the same answer. The counts serialize as
 * flat arrays, come back in a couple of seconds, and the file is
 * named for the play file's timestamp so a rebuilt file counts anew.
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  countPlays, type CountedPlays, type PlayRow,
} from "./fitPlayFactors.js";

const KEPT = join(import.meta.dirname, "..", "..", "data", "kept");
const TOUCHES = join(
  import.meta.dirname, "..", "..", "data", "curated", "touches.csv",
);

interface Flat {
  cells: [string, number, number, number, number[], number[],
    [number, number, number],
    [string, number, number, number, number][],
    [number, number[]][]][];
  byMan: [string, number, number, number][];
  leagueOn: [string, number, number, number][];
  caughtAt: [number, number, number][];
  overall: [string, number][];
  everyTouch: number;
  inScript: [string, number][];
  scriptPlays: [string, number][];
  onCall: [string, number][];
  callPlays: [string, number][];
}

const flatten = (counted: CountedPlays): Flat => ({
  cells: [...counted.cells.entries()].map(([key, c]) => [
    key, c.plays, c.runs, c.scores, c.yards, c.from,
    [c.named.touches, c.named.yards, c.named.long],
    [...c.byPlayer.entries()].map(([id, o]) =>
      [id, o.touches, o.yards, o.scores, o.long]),
    [...c.byDepth.entries()],
  ]),
  byMan: [...counted.byMan.entries()].map(([k, r]) => [k, r.touches, r.yards, r.long]),
  leagueOn: [...counted.leagueOn.entries()].map(([k, r]) => [k, r.touches, r.yards, r.long]),
  caughtAt: [...counted.caughtAt.entries()].map(([k, o]) => [k, o.threw, o.caught]),
  overall: [...counted.overall.entries()],
  everyTouch: counted.everyTouch,
  inScript: [...counted.inScript.entries()],
  scriptPlays: [...counted.scriptPlays.entries()],
  onCall: [...counted.onCall.entries()],
  callPlays: [...counted.callPlays.entries()],
});

const raise = (flat: Flat): CountedPlays => ({
  cells: new Map(flat.cells.map(([key, plays, runs, scores, yards, from, named, byPlayer, byDepth]) => [
    key,
    {
      plays, runs, scores, yards, from,
      named: { touches: named[0], yards: named[1], long: named[2] },
      byPlayer: new Map(byPlayer.map(([id, touches, y, sc, long]) =>
        [id, { touches, yards: y, scores: sc, long }])),
      byDepth: new Map(byDepth),
    },
  ])),
  byOffence: new Map(),
  byDefence: new Map(),
  byMan: new Map(flat.byMan.map(([k, touches, yards, long]) => [k, { touches, yards, long }])),
  leagueOn: new Map(flat.leagueOn.map(([k, touches, yards, long]) => [k, { touches, yards, long }])),
  caughtAt: new Map(flat.caughtAt.map(([k, threw, caught]) => [k, { threw, caught }])),
  overall: new Map(flat.overall),
  everyTouch: flat.everyTouch,
  inScript: new Map(flat.inScript),
  scriptPlays: new Map(flat.scriptPlays),
  onCall: new Map(flat.onCall),
  callPlays: new Map(flat.callPlays),
});

/**
 * The counts for rows below this season, from the disk when they are
 * there. Only the sideless counting is kept, which is the kind every
 * caller with a pairing wants.
 */
export async function countsFor(
  maxSeason: number, rows: () => PlayRow[],
): Promise<CountedPlays> {
  const stamp = await stat(TOUCHES).then((s) => s.mtimeMs).catch(() => 0);
  // the counting changes shape sometimes, and an older file would come
  // back missing whatever was added since
  const at = join(KEPT, `counts2-${maxSeason}-${Math.round(stamp)}.json`);
  const already = await readFile(at, "utf8").catch(() => "");

  if (already) {
    return raise(JSON.parse(already) as Flat);
  }

  const counted = countPlays(rows(), false);
  await mkdir(KEPT, { recursive: true }).catch(() => undefined);
  await writeFile(at, JSON.stringify(flatten(counted))).catch(() => undefined);

  return counted;
}

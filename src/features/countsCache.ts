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
  fromFormation?: [string, { plays: number; runs: number }][];
  /**
   * The per side counts, slim: a side cell only ever answers with its
   * plays, its runs and its yards, so the player and depth maps that
   * ride along in the full shape stay home.
   */
  bySide: [string, string, number, number, number, number[]][];
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
  fromFormation: [...counted.fromFormation.entries()],
  bySide: [
    ...[...counted.byOffence.entries()].map(([k, c]) =>
      ["o", k, c.plays, c.runs, c.scores, c.yards] as
        [string, string, number, number, number, number[]]),
    ...[...counted.byDefence.entries()].map(([k, c]) =>
      ["d", k, c.plays, c.runs, c.scores, c.yards] as
        [string, string, number, number, number, number[]]),
  ],
});

const sideCell = (
  plays: number, runs: number, scores: number, yards: number[],
) => ({
  plays, runs, scores, yards, from: [],
  named: { touches: 0, yards: 0, long: 0 },
  byPlayer: new Map(), byDepth: new Map(),
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
  byOffence: new Map(flat.bySide.filter(([w]) => w === "o")
    .map(([, k, plays, runs, scores, yards]) =>
      [k, sideCell(plays, runs, scores, yards)])),
  byDefence: new Map(flat.bySide.filter(([w]) => w === "d")
    .map(([, k, plays, runs, scores, yards]) =>
      [k, sideCell(plays, runs, scores, yards)])),
  byMan: new Map(flat.byMan.map(([k, touches, yards, long]) => [k, { touches, yards, long }])),
  leagueOn: new Map(flat.leagueOn.map(([k, touches, yards, long]) => [k, { touches, yards, long }])),
  caughtAt: new Map(flat.caughtAt.map(([k, threw, caught]) => [k, { threw, caught }])),
  overall: new Map(flat.overall),
  everyTouch: flat.everyTouch,
  inScript: new Map(flat.inScript),
  scriptPlays: new Map(flat.scriptPlays),
  onCall: new Map(flat.onCall),
  callPlays: new Map(flat.callPlays),
  fromFormation: new Map(flat.fromFormation ?? []),
});

/**
 * The counts for rows below this season, from the disk when they are
 * there. The per side counts ride along, because leaving them out
 * disconnected every team from its own run rate and its own yards:
 * the walk played four seasons of evals with the teams identical at
 * the play level, and four in season experiments read as null against
 * maps that were empty.
 */
export async function countsFor(
  maxSeason: number, rows: () => PlayRow[],
): Promise<CountedPlays> {
  const stamp = await stat(TOUCHES).then((s) => s.mtimeMs).catch(() => 0);
  // the counting changes shape sometimes, and an older file would come
  // back missing whatever was added since
  const at = join(KEPT, `counts4-${maxSeason}-${Math.round(stamp)}.json`);
  const already = await readFile(at, "utf8").catch(() => "");

  if (already) {
    return raise(JSON.parse(already) as Flat);
  }

  const counted = countPlays(rows());
  await mkdir(KEPT, { recursive: true }).catch(() => undefined);
  await writeFile(at, JSON.stringify(flatten(counted))).catch(() => undefined);

  return counted;
}

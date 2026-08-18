/**
 * What a man did once somebody had hold of him.
 *
 * Yards a carry is the line as much as the back: 2.52 of a 4.4 yard
 * carry happens before contact, and that part follows a man who
 * changes teams at .16 where what he makes after contact follows him at
 * .35. So a description built on the whole gain is asking about
 * something that is mostly not him.
 *
 * From Pro Football Reference by way of nflverse, joined through the
 * player file, which carries both kinds of identifier.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR } from "./nflverse.js";

export interface AfterContact {
  /** yards a carry before anybody touched him, which is the line */
  beforeContact: number;
  /** and after, which is him */
  afterContact: number;
  /** how often a carry breaks a tackle */
  brokenPerCarry: number;
  /** how far downfield he is thrown to */
  targetDepth: number;
  /** yards he makes after catching it */
  afterCatch: number;
  /** how often a catchable ball goes down */
  dropRate: number;
}

/** gsis id to pfr id, since the advanced stats only carry the latter */
export async function pfrToGsis(): Promise<Map<string, string>> {
  const rows = parseCsv(await readFile(join(RAW_DIR, "players.csv"), "utf8"));
  const out = new Map<string, string>();

  for (const row of rows) {
    const gsis = row["gsis_id"] ?? "";
    const pfr = row["pfr_id"] ?? "";

    if (gsis.startsWith("00-") && pfr) {
      out.set(pfr, gsis);
    }
  }

  return out;
}

/** one back's season of carrying, with the side he did it for */
export interface RushingSeason {
  /** the reference's own identifier, the only one in this file */
  pfrId: string;
  team: string;
  season: number;
  attempts: number;
  perCarry: number;
  beforeContact: number;
  afterContact: number;
  /** carries between broken tackles, so smaller is better */
  brokenPer: number;
}

/**
 * Every back's season of carrying, for questions about what travels.
 *
 * Kept apart from the season lookup above because these questions
 * compare a man with himself a year later, and want the team he did it
 * for rather than a description to hang on a player.
 */
export async function loadRushingSeasons(
  leastCarries = 60,
): Promise<RushingSeason[]> {
  return parseCsv(await readFile(join(RAW_DIR, "advstats_rush.csv"), "utf8"))
    .map((row) => ({
      pfrId: row["pfr_id"] ?? "",
      team: row["tm"] ?? "",
      season: Number(row["season"]),
      attempts: Number(row["att"]) || 0,
      perCarry: Number(row["yds"]) / Math.max(1, Number(row["att"])),
      beforeContact: Number(row["ybc_att"]) || 0,
      afterContact: Number(row["yac_att"]) || 0,
      brokenPer: Number(row["att_br"]) || 0,
    }))
    .filter((row) => row.pfrId && row.attempts >= leastCarries);
}

export async function loadAfterContact(
  season: number,
): Promise<Map<string, AfterContact>> {
  const toGsis = await pfrToGsis();
  const out = new Map<string, AfterContact>();

  const rushing = parseCsv(await readFile(join(RAW_DIR, "advstats_rush.csv"), "utf8"))
    .filter((r) => Number(r["season"]) === season);

  for (const row of rushing) {
    const id = toGsis.get(row["pfr_id"] ?? "");

    if (!id || Number(row["att"]) < 20) {
      continue;
    }

    out.set(id, {
      beforeContact: Number(row["ybc_att"]) || 0,
      afterContact: Number(row["yac_att"]) || 0,
      brokenPerCarry: Number(row["att_br"]) > 0 ? 1 / Number(row["att_br"]) : 0,
      targetDepth: 0, afterCatch: 0, dropRate: 0,
    });
  }

  const catching = parseCsv(await readFile(join(RAW_DIR, "advstats_rec.csv"), "utf8"))
    .filter((r) => Number(r["season"]) === season);

  for (const row of catching) {
    const id = toGsis.get(row["pfr_id"] ?? "");

    if (!id || Number(row["rec"]) < 10) {
      continue;
    }

    const already = out.get(id) ?? {
      beforeContact: 0, afterContact: 0, brokenPerCarry: 0,
      targetDepth: 0, afterCatch: 0, dropRate: 0,
    };
    already.targetDepth = Number(row["adot"]) || 0;
    already.afterCatch = Number(row["yac_r"]) || 0;
    already.dropRate = Number(row["drop_percent"]) || 0;
    out.set(id, already);
  }

  return out;
}

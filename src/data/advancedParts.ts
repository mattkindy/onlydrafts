/**
 * The advanced stat files, keyed the way the rest of the repo keys
 * players.
 *
 * Those files name a man by his pro football reference id and
 * everything else here uses the nflverse one, so the players file
 * has both and does the joining.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR } from "./nflverse.js";
import { noParts, type Parts } from "../features/jointParts.js";

type Row = Record<string, string>;

const n = (r: Row, key: string) => Number(r[key]) || 0;

let joined: Map<string, string> | undefined;

/** pro football reference's id to nflverse's, from the players file */
async function idsAcross(): Promise<Map<string, string>> {
  if (joined) {
    return joined;
  }

  const rows = parseCsv(await readFile(join(RAW_DIR, "players.csv"), "utf8"));
  joined = new Map();

  for (const r of rows) {
    const pfr = r["pfr_id"] ?? "";
    const gsis = r["gsis_id"] ?? "";

    if (pfr && gsis) {
      joined.set(pfr, gsis);
    }
  }

  return joined;
}

/**
 * Every man's season in the parts a play is made of, by nflverse id.
 * A man in neither file is absent rather than zeroed, so a caller can
 * tell "he did nothing" from "we have nothing".
 */
export async function partsIn(season: number): Promise<Map<string, Parts>> {
  const across = await idsAcross();
  const out = new Map<string, Parts>();

  const take = async (file: string, into: (parts: Parts, r: Row) => void) => {
    const rows = parseCsv(await readFile(join(RAW_DIR, file), "utf8"));

    for (const r of rows) {
      if (Number(r["season"]) !== season) {
        continue;
      }

      const who = across.get(r["pfr_id"] ?? "");

      if (!who) {
        continue;
      }

      const parts = out.get(who) ?? noParts();
      parts.games = Math.max(parts.games, n(r, "g"));
      parts.age = n(r, "age") || parts.age;
      into(parts, r);
      out.set(who, parts);
    }
  };

  await take("advstats_rec.csv", (parts, r) => {
    parts.targets = n(r, "tgt");
    parts.receptions = n(r, "rec");
    parts.beforeCatch = n(r, "ybc");
    parts.afterCatch = n(r, "yac");
    parts.drops = n(r, "drop");
  });

  await take("advstats_rush.csv", (parts, r) => {
    parts.carries = n(r, "att");
    parts.beforeContact = n(r, "ybc");
    parts.afterContact = n(r, "yac");
  });

  return out;
}

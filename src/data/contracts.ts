/**
 * What a team paid, which is the only thing that says whether a man was
 * brought in to play or to sit.
 *
 * The model does well on players who stayed where they were and badly
 * on the ones who moved, because a mover's history is on a team he no
 * longer plays for and nothing says what his new one wants from him.
 * A draft round says that for a rookie. For a veteran, the money does.
 *
 * From OverTheCap by way of nflverse. There are no gsis ids in it, so
 * it joins on a normalized name and a position.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { normalizeName } from "./names.js";
import { RAW_DIR } from "./nflverse.js";

export interface Contract {
  name: string;
  position: string;
  team: string;
  yearSigned: number;
  years: number;
  /** the yearly money as a share of that year's cap, so eras compare */
  capShare: number;
  guaranteed: number;
}

/** keyed by normalized name and position, newest signing first */
export async function loadContracts(): Promise<Map<string, Contract[]>> {
  const rows = parseCsv(await readFile(join(RAW_DIR, "contracts.csv"), "utf8"));
  const byPlayer = new Map<string, Contract[]>();

  for (const row of rows) {
    const yearSigned = Number(row["year_signed"]);
    const capShare = Number(row["apy_cap_pct"]);

    if (!Number.isFinite(yearSigned) || !Number.isFinite(capShare)) {
      continue;
    }

    const key = `${normalizeName(row["player"] ?? "")}|${row["position"] ?? ""}`;
    byPlayer.set(key, [...(byPlayer.get(key) ?? []), {
      name: row["player"] ?? "", position: row["position"] ?? "",
      team: row["team"] ?? "", yearSigned, years: Number(row["years"]) || 1,
      capShare, guaranteed: Number(row["guaranteed"]) || 0,
    }]);
  }

  for (const [key, deals] of byPlayer) {
    byPlayer.set(key, deals.sort((a, b) => b.yearSigned - a.yearSigned));
  }

  return byPlayer;
}

/** the deal he was playing under in a given season */
export function dealFor(
  contracts: Map<string, Contract[]>,
  name: string,
  position: string,
  season: number,
): Contract | undefined {
  const deals = contracts.get(`${normalizeName(name)}|${position}`) ?? [];

  return deals.find((deal) =>
    deal.yearSigned <= season && deal.yearSigned + deal.years > season) ??
    deals.find((deal) => deal.yearSigned <= season);
}

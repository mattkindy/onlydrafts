/**
 * Tries variants of the availability model against the same seasons and
 * prints what each one costs.
 *
 * Every variant is fitted on the seasons before the one being tested,
 * so nothing reads the future. Run: npx tsx scripts/durabilityLab.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadGames, loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const RAW = join(import.meta.dirname, "..", "data", "raw");
const WANTED = ["QB", "RB", "WR", "TE"];
const ROOM = 17;
const TEST = [2022, 2023, 2024, 2025];
const FROM = 2017;

/** a knee is not an ankle, and neither of them is an illness */
const SLOW_TO_HEAL = /achilles|acl|patell|tear|fracture|broken|lisfranc|labrum|rotator|pectoral|hip|back|neck|spine|foot|leg/i;
const QUICK = /illness|rest|personal|not injury|coach|load/i;

export interface Man {
  id: string;
  season: number;
  position: string;
  games: number;
  gamesPrev: number;
  gamesPrev2?: number;
  gamesPrev3?: number;
  age?: number;
  touchesPerGame: number;
  weightPounds?: number;
  weeksOut: number;
  weeksListed: number;
  endedHurt: boolean;
  onTurf: number;
  /** weeks he did not practise at all, which beats what the report says */
  weeksNoPractice: number;
  /** and weeks he was limited but played anyway */
  weeksLimited: number;
  /** the longest run of weeks he was out in one go */
  longestOut: number;
  /** whether anything on his report is slow to heal */
  slowInjury: boolean;
  /** his share of the touches his side gave his position last year */
  roleShare: number;
  pointsPerGame: number;
}

interface Season {
  games: Map<string, number>;
  touches: Map<string, number>;
  position: Map<string, string>;
  team: Map<string, string>;
  born: Map<string, string>;
  weight: Map<string, number>;
  weeksOut: Map<string, number>;
  weeksListed: Map<string, number>;
  weeksNoPractice: Map<string, number>;
  weeksLimited: Map<string, number>;
  longestOut: Map<string, number>;
  slow: Set<string>;
  endedHurt: Set<string>;
  turf: Map<string, number>;
  touchShare: Map<string, number>;
  ppg: Map<string, number>;
}

async function readSeason(season: number): Promise<Season> {
  const out: Season = {
    games: new Map(), touches: new Map(), position: new Map(), team: new Map(),
    born: new Map(), weight: new Map(), weeksOut: new Map(),
    weeksListed: new Map(), weeksNoPractice: new Map(), weeksLimited: new Map(),
    longestOut: new Map(), slow: new Set(), endedHurt: new Set(),
    turf: new Map(), touchShare: new Map(), ppg: new Map(),
  };
  const points = new Map<string, number>();

  for (const w of await loadPlayerStats(season).catch(() => [])) {
    if (w.week > 18 || !WANTED.includes(w.position)) {
      continue;
    }

    out.games.set(w.playerId, (out.games.get(w.playerId) ?? 0) + 1);
    out.touches.set(
      w.playerId,
      (out.touches.get(w.playerId) ?? 0) + (w.targets ?? 0) + (w.carries ?? 0),
    );
    out.position.set(w.playerId, w.position);
    out.team.set(w.playerId, w.teamId);
    const line = w.statLine as unknown as Record<string, number>;
    points.set(w.playerId, (points.get(w.playerId) ?? 0) +
      (line["rushYds"] ?? 0) * 0.1 + (line["recYds"] ?? 0) * 0.1 +
      (line["receptions"] ?? 0) + (line["passYds"] ?? 0) * 0.04 +
      ((line["rushTd"] ?? 0) + (line["recTd"] ?? 0)) * 6 +
      (line["passTd"] ?? 0) * 4);
  }

  for (const [id, n] of points) {
    out.ppg.set(id, n / Math.max(1, out.games.get(id) ?? 1));
  }

  // a backup plays few games because he is a backup, and reading that
  // as fragility makes every reserve look injury prone
  const byTeamPosition = new Map<string, number>();

  for (const [id, n] of out.touches) {
    const key = out.team.get(id) + "|" + out.position.get(id);
    byTeamPosition.set(key, (byTeamPosition.get(key) ?? 0) + n);
  }

  for (const [id, n] of out.touches) {
    const all = byTeamPosition.get(out.team.get(id) + "|" + out.position.get(id)) ?? 0;
    out.touchShare.set(id, all > 0 ? n / all : 0);
  }

  for (const row of await loadWeeklyRosters(season).catch(() => [])) {
    if (row.birthDate && !out.born.has(row.playerId)) {
      out.born.set(row.playerId, row.birthDate);
    }

    if (row.weightPounds && !out.weight.has(row.playerId)) {
      out.weight.set(row.playerId, row.weightPounds);
    }
  }

  const hurt = parseCsv(
    await readFile(join(RAW, `injuries_${season}.csv`), "utf8").catch(() => ""),
  );
  let latest = 0;

  for (const r of hurt) {
    latest = Math.max(latest, Number(r["week"]) || 0);
  }

  const outWeeks = new Map<string, number[]>();

  for (const r of hurt) {
    const id = r["gsis_id"] ?? "";
    const status = r["report_status"] ?? "";
    const practice = r["practice_status"] ?? "";
    const what = (r["report_primary_injury"] ?? "") + " " +
      (r["practice_primary_injury"] ?? "");

    if (!id) {
      continue;
    }

    if (status) {
      out.weeksListed.set(id, (out.weeksListed.get(id) ?? 0) + 1);
    }

    if (/did not participate/i.test(practice)) {
      out.weeksNoPractice.set(id, (out.weeksNoPractice.get(id) ?? 0) + 1);
    } else if (/limited/i.test(practice)) {
      out.weeksLimited.set(id, (out.weeksLimited.get(id) ?? 0) + 1);
    }

    if (SLOW_TO_HEAL.test(what) && !QUICK.test(what)) {
      out.slow.add(id);
    }

    if (["Out", "Doubtful"].includes(status)) {
      out.weeksOut.set(id, (out.weeksOut.get(id) ?? 0) + 1);
      outWeeks.set(id, [...(outWeeks.get(id) ?? []), Number(r["week"]) || 0]);

      if (Number(r["week"]) >= latest - 1) {
        out.endedHurt.add(id);
      }
    }
  }

  // one long absence and six scattered weeks are different injuries
  // wearing the same total
  for (const [id, weeks] of outWeeks) {
    const sorted = [...new Set(weeks)].sort((a, b) => a - b);
    let best = 1;
    let run = 1;

    for (let i = 1; i < sorted.length; i++) {
      run = sorted[i] === sorted[i - 1]! + 1 ? run + 1 : 1;
      best = Math.max(best, run);
    }

    out.longestOut.set(id, best);
  }

  const turf = new Map<string, { turf: number; all: number }>();

  for (const g of await loadGames()) {
    if (g.season !== season || !g.homeTeamId) {
      continue;
    }

    const seen = turf.get(g.homeTeamId) ?? { turf: 0, all: 0 };
    seen.all++;

    if ((g.surface ?? "grass") !== "grass") {
      seen.turf++;
    }

    turf.set(g.homeTeamId, seen);
  }

  for (const [team, seen] of turf) {
    out.turf.set(team, seen.all > 0 ? seen.turf / seen.all : 0.5);
  }

  return out;
}

export async function readMen(): Promise<Man[]> {
  const years = new Map<number, Season>();

  for (let s = FROM - 3; s <= Math.max(...TEST); s++) {
    years.set(s, await readSeason(s));
  }

  const men: Man[] = [];

  for (let season = FROM; season <= Math.max(...TEST); season++) {
    const now = years.get(season)!;
    const prev = years.get(season - 1)!;

    for (const [id, games] of now.games) {
      const gamesPrev = prev.games.get(id);

      // a rookie is a different question from whether a known player
      // stays on the field
      if (gamesPrev === undefined) {
        continue;
      }

      const born = prev.born.get(id) ?? now.born.get(id);
      men.push({
        id,
        season,
        position: now.position.get(id) ?? prev.position.get(id) ?? "WR",
        games,
        gamesPrev,
        gamesPrev2: years.get(season - 2)?.games.get(id),
        gamesPrev3: years.get(season - 3)?.games.get(id),
        age: born ? season - Number(born.slice(0, 4)) : undefined,
        touchesPerGame: (prev.touches.get(id) ?? 0) / Math.max(1, gamesPrev),
        weightPounds: prev.weight.get(id),
        weeksOut: prev.weeksOut.get(id) ?? 0,
        weeksListed: prev.weeksListed.get(id) ?? 0,
        weeksNoPractice: prev.weeksNoPractice.get(id) ?? 0,
        weeksLimited: prev.weeksLimited.get(id) ?? 0,
        longestOut: prev.longestOut.get(id) ?? 0,
        slowInjury: prev.slow.has(id),
        endedHurt: prev.endedHurt.has(id),
        onTurf: prev.turf.get(prev.team.get(id) ?? "") ?? 0.5,
        roleShare: prev.touchShare.get(id) ?? 0,
        pointsPerGame: prev.ppg.get(id) ?? 0,
      });
    }
  }

  return men;
}

/** the model as it stands today */
export function nowRow(r: Man): number[] {
  const played = (n: number | undefined) => (n === undefined ? 14 : n);

  return [
    1,
    r.gamesPrev / ROOM,
    played(r.gamesPrev2) / ROOM,
    played(r.gamesPrev3) / ROOM,
    r.gamesPrev2 === undefined ? 1 : 0,
    (r.age ?? 26) - 26,
    Math.max(0, (r.age ?? 26) - 29),
    r.position === "RB" ? 1 : 0,
    r.position === "QB" ? 1 : 0,
    r.position === "TE" ? 1 : 0,
    r.touchesPerGame / 20,
    r.position === "RB" ? r.touchesPerGame / 20 : 0,
    ((r.weightPounds ?? 210) - 210) / 40,
    r.weeksOut / ROOM,
    r.weeksListed / ROOM,
    r.endedHurt ? 1 : 0,
    r.onTurf,
  ];
}

export interface Variant {
  name: string;
  row: (r: Man) => number[];
  lambda: number;
}

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const order = xs.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
    const out: number[] = new Array(xs.length).fill(0);
    order.forEach(([, i], k) => { out[i] = k; });

    return out;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const mean = (n - 1) / 2;
  let top = 0;
  let sa = 0;
  let sb = 0;

  for (let i = 0; i < n; i++) {
    top += (ra[i]! - mean) * (rb[i]! - mean);
    sa += (ra[i]! - mean) ** 2;
    sb += (rb[i]! - mean) ** 2;
  }

  return top / Math.sqrt(sa * sb);
}

const at = (a: number[], p: number) =>
  [...a].sort((x, y) => y - x)[Math.min(a.length - 1, Math.floor(a.length * p))]!;

export function score(men: Man[], variant: Variant) {
  let mae = 0;
  let order = 0;
  let p90 = 0;
  let real90 = 0;
  let busyMae = 0;
  let busyOrder = 0;

  for (const season of TEST) {
    const train = men.filter((m) => m.season < season && m.season >= FROM);
    const test = men.filter((m) => m.season === season);
    const weights = fitRidge(
      train.map(variant.row), train.map((m) => m.games / ROOM), variant.lambda,
    );
    const said = test.map((m) =>
      Math.min(ROOM, Math.max(1, predictRidge(weights, variant.row(m)) * ROOM)));
    const actual = test.map((m) => m.games);

    mae += said.reduce((s, v, i) => s + Math.abs(v - actual[i]!), 0) /
      said.length / TEST.length;
    order += spearman(said, actual) / TEST.length;
    p90 += at(said, 0.1) / TEST.length;
    real90 += at(actual, 0.1) / TEST.length;

    // the men a drafter cares about, which is the busy end
    const busy = test
      .map((m, i) => ({ m, said: said[i]!, actual: actual[i]! }))
      .filter((x) => x.m.roleShare >= 0.15);
    busyMae += busy.reduce((s, x) => s + Math.abs(x.said - x.actual), 0) /
      Math.max(1, busy.length) / TEST.length;
    busyOrder += spearman(busy.map((x) => x.said), busy.map((x) => x.actual)) /
      TEST.length;
  }

  return { mae, order, p90, real90, busyMae, busyOrder };
}

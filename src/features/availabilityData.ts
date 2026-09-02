/**
 * The seasons an availability model reads: who played when, how much
 * he was given, how old and how big he is, what the injury report
 * said about him, and how much of his home schedule is on turf.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import {
  loadGames, loadPlayerStats, loadWeeklyRosters,
} from "../data/nflverse.js";
import type { AvailabilityRow } from "./gamesPlayed.js";
import {
  openedOnReserve, readSignals, type SeasonSignals,
} from "./durabilitySignals.js";

const WANTED = ["QB", "RB", "WR", "TE"];
const RAW = join(import.meta.dirname, "..", "..", "data", "raw");

interface Season {
  games: Map<string, number>;
  lastWeek: Map<string, number>;
  touches: Map<string, number>;
  position: Map<string, string>;
  team: Map<string, string>;
  born: Map<string, string>;
  weight: Map<string, number>;
  height: Map<string, number>;
  weeksOut: Map<string, number>;
  weeksListed: Map<string, number>;
  endedHurt: Set<string>;
  turf: Map<string, number>;
  signals: SeasonSignals;
}

async function readSeason(season: number): Promise<Season> {
  const out: Season = {
    games: new Map(), lastWeek: new Map(), touches: new Map(),
    position: new Map(), team: new Map(), born: new Map(),
    weight: new Map(), height: new Map(),
    weeksOut: new Map(), weeksListed: new Map(), endedHurt: new Set(),
    turf: new Map(),
    signals: {
      onReserve: new Map(), inactive: new Map(), activeWeeks: new Map(),
      snapShare: new Map(), bestSnapShare: new Map(), reserveSpells: new Map(),
    },
  };

  for (const w of await loadPlayerStats(season).catch(() => [])) {
    if (w.week > 18 || !WANTED.includes(w.position)) {
      continue;
    }

    out.games.set(w.playerId, (out.games.get(w.playerId) ?? 0) + 1);
    out.lastWeek.set(w.playerId, Math.max(out.lastWeek.get(w.playerId) ?? 0, w.week));
    /**
     * A quarterback's work is his dropbacks, so they count here.
     *
     * Counting only what he was handed or thrown made every starting
     * quarterback look like a five touch player, which is a backup's
     * profile, and how much a man is given is the second strongest
     * signal of whether he stays on the field. The board came out
     * expecting quarterbacks to play 8.8 games where the rest of the
     * board got 12.7 to 13.3, and the men who finish worth starting
     * play about 14.8 whatever they do.
     */
    out.touches.set(
      w.playerId,
      (out.touches.get(w.playerId) ?? 0) + (w.targets ?? 0) +
        (w.carries ?? 0) + (w.passing?.attempts ?? 0),
    );
    out.position.set(w.playerId, w.position);
    out.team.set(w.playerId, w.teamId);
  }

  for (const row of await loadWeeklyRosters(season).catch(() => [])) {
    if (!out.born.has(row.playerId)) {
      if (row.birthDate) out.born.set(row.playerId, row.birthDate);
      if (row.weightPounds) out.weight.set(row.playerId, row.weightPounds);
      if (row.heightInches) out.height.set(row.playerId, row.heightInches);
    }
  }

  const hurt = parseCsv(
    await readFile(join(RAW, `injuries_${season}.csv`), "utf8").catch(() => ""),
  );
  let latest = 0;

  for (const r of hurt) {
    latest = Math.max(latest, Number(r["week"]) || 0);
  }

  for (const r of hurt) {
    const id = r["gsis_id"] ?? "";
    const status = r["report_status"] ?? "";

    if (!id || !status) {
      continue;
    }

    out.weeksListed.set(id, (out.weeksListed.get(id) ?? 0) + 1);

    if (["Out", "Doubtful"].includes(status)) {
      out.weeksOut.set(id, (out.weeksOut.get(id) ?? 0) + 1);

      // still on the report as the season closed, so he brings it into next year
      if (Number(r["week"]) >= latest - 1) {
        out.endedHurt.add(id);
      }
    }
  }

  const onTurf = new Map<string, { turf: number; all: number }>();

  for (const g of await loadGames()) {
    if (g.season !== season || !g.homeTeamId) {
      continue;
    }

    const seen = onTurf.get(g.homeTeamId) ?? { turf: 0, all: 0 };
    seen.all++;
    if ((g.surface ?? "grass") !== "grass") seen.turf++;
    onTurf.set(g.homeTeamId, seen);
  }

  for (const [team, seen] of onTurf) {
    out.turf.set(team, seen.all > 0 ? seen.turf / seen.all : 0.5);
  }

  out.signals = await readSignals(season);

  return out;
}

const ageAt = (born: string | undefined, season: number) =>
  born ? season - Number(born.slice(0, 4)) : undefined;


export interface AvailabilityWorld {
  byYear: Map<number, Season>;
  rowsFor: (season: number) => AvailabilityRow[];
}

/** every season a fit needs, read once */
export async function readAvailability(
  seasons: number[],
): Promise<AvailabilityWorld> {
  const byYear = new Map<number, Season>();
  const wanted = new Set<number>();

  for (const s of seasons) {
    for (const back of [0, 1, 2, 3]) {
      wanted.add(s - back);
    }
  }

  for (const s of [...wanted].sort()) {
    byYear.set(s, await readSeason(s));
  }

  const openedHurt = new Map<number, Set<string>>();

  for (const s of seasons) {
    openedHurt.set(s, await openedOnReserve(s));
  }

  const rowsFor = (season: number): AvailabilityRow[] => {
    const was = byYear.get(season - 1);
    const is = byYear.get(season);
    const out: AvailabilityRow[] = [];

    if (!was) {
      return out;
    }

    for (const [playerId, games] of was.games) {
      if (games < 4) {
        continue;
      }

      const team = was.team.get(playerId) ?? "";
      out.push({
        playerId, season,
        position: was.position.get(playerId) ?? "WR",
        gamesPrev: games,
        gamesPrev2: byYear.get(season - 2)?.games.get(playerId),
        gamesPrev3: byYear.get(season - 3)?.games.get(playerId),
        age: ageAt(was.born.get(playerId), season),
        touchesPerGame: (was.touches.get(playerId) ?? 0) / games,
        weightPounds: was.weight.get(playerId),
        heightInches: was.height.get(playerId),
        weeksOut: was.weeksOut.get(playerId) ?? 0,
        weeksListed: was.weeksListed.get(playerId) ?? 0,
        endedHurt: was.endedHurt.has(playerId),
        onTurf: was.turf.get(team) ?? 0.5,
        weeksOnReserve: was.signals.onReserve.get(playerId) ?? 0,
        openedOnReserve: openedHurt.get(season)?.has(playerId) ?? false,
        played: is ? is.games.get(playerId) ?? 0 : undefined,
      });
    }

    return out;
  };

  return { byYear, rowsFor };
}

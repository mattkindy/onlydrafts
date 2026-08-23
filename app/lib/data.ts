/**
 * The board as it ships, read into what the page works with.
 *
 * The file says what each man does in a game and where rooms draft
 * him, and nothing about scoring. Reading it is the only place that
 * knows the file's field names.
 */

import type { Player } from "./scoring.ts";

export interface Meta {
  weeks: number[];
  boardSeason: number;
  adpFormat?: string;
}

interface FileRow {
  name: string;
  key: string;
  position: string;
  team?: string | null;
  projected?: Record<string, number> | null;
  simulated?: Record<string, number> | null;
  ppg?: number;
  touches?: number | null;
  adp?: number | null;
  adpLow?: number | null;
  adpHigh?: number | null;
  adpBy?: Player["adpBy"];
  bye?: number | null;
  rookie?: boolean;
  plus?: string[];
  minus?: string[];
  game?: Record<string, number> | null;
  sim?: (Record<string, number> & { games: number }) | null;
  weeks?: { w: number; opp: string; of: number }[];
}

export interface Board {
  players: Player[];
  plusMinus: Map<string, { plus: string[]; minus: string[] }>;
}

/** the file changes far more often than a browser expects */
const fresh = () => "?v=" + Math.floor(Date.now() / 60000);

export async function loadMeta(): Promise<Meta> {
  return await fetch("data/index.json" + fresh()).then((r) => r.json());
}

export async function loadBoard(season: number): Promise<Board> {
  const said = await fetch(`data/board-${season}.json${fresh()}`)
    .then((r) => r.json()) as { players: FileRow[] };
  const plusMinus = new Map<string, { plus: string[]; minus: string[] }>();

  const players = said.players.map((row): Player => {
    plusMinus.set(row.key, { plus: row.plus ?? [], minus: row.minus ?? [] });

    return {
      name: row.name,
      key: row.key,
      position: row.position,
      team: row.team ?? null,
      projected: row.projected ?? null,
      simulated: row.simulated ?? null,
      weeks: row.weeks ?? [],
      adp: row.adp ?? null,
      adpLow: row.adpLow ?? null,
      adpHigh: row.adpHigh ?? null,
      adpBy: row.adpBy ?? null,
      bye: row.bye ?? null,
      touches: row.touches ?? null,
      rookie: row.rookie ?? false,
      game: row.game ?? null,
      sim: row.sim ?? null,
      ppg: row.ppg ?? 0,
    };
  });

  return { players, plusMinus };
}

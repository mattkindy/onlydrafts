/**
 * The board as it ships, read into what the page works with.
 *
 * The file says what each player does in a game and where rooms draft
 * him, and nothing about scoring. Reading it is the only place that
 * knows the file's field names.
 */

import type { Player, Sleeper } from "./scoring.ts";

export interface Meta {
  /**
   * The weeks with a slate file built. Older indexes list bare week
   * numbers, so what comes back is put through weekRefs rather than
   * read straight.
   */
  weeks: unknown;
  boardSeason: number;
  adpFormat?: string;
}

interface FileRow {
  name: string;
  key: string;
  position: string;
  team?: string | null;
  projected?: Record<string, number> | null;
  walked?: Record<string, number> | null;
  simulated?: Record<string, number> | null;
  ppg?: number;
  touches?: number | null;
  adp?: number | null;
  adpLow?: number | null;
  adpHigh?: number | null;
  adpBy?: Player["adpBy"];
  bye?: number | null;
  rookie?: boolean;
  sleeper?: Sleeper | null;
  plus?: string[];
  minus?: string[];
  game?: Record<string, number> | null;
  sim?: (Record<string, number> & { games: number }) | null;
  weeks?: Player["weeks"];
}

/** what the build paid a catch when it scored the board */
const BOARD_PER_CATCH = 1;

export interface Board {
  players: Player[];
  plusMinus: Map<string, { plus: string[]; minus: string[] }>;
  /** who each side plays each week, missing on an older file */
  schedule?: Record<string, (string | null)[]> | null;
  /**
   * What a catch paid when the board's weekly blends were scored, so a
   * league paying differently can move them.
   */
  perCatch: number;
}

/** the file changes far more often than a browser expects */
const fresh = () => "?v=" + Math.floor(Date.now() / 60000);

export async function loadMeta(): Promise<Meta> {
  return await fetch("data/index.json" + fresh()).then((r) => r.json());
}

export async function loadBoard(season: number): Promise<Board> {
  const said = await fetch(`data/board-${season}.json${fresh()}`)
    .then((r) => r.json()) as {
      players: FileRow[];
      schedule?: Record<string, (string | null)[]> | null;
      scoredBy?: { receptions?: number } | null;
    };
  const plusMinus = new Map<string, { plus: string[]; minus: string[] }>();

  const players = said.players.map((row): Player => {
    plusMinus.set(row.key, { plus: row.plus ?? [], minus: row.minus ?? [] });

    return {
      name: row.name,
      key: row.key,
      position: row.position,
      team: row.team ?? null,
      projected: row.projected ?? null,
      walked: row.walked ?? null,
      simulated: row.simulated ?? null,
      weeks: row.weeks ?? [],
      adp: row.adp ?? null,
      adpLow: row.adpLow ?? null,
      adpHigh: row.adpHigh ?? null,
      adpBy: row.adpBy ?? null,
      bye: row.bye ?? null,
      touches: row.touches ?? null,
      rookie: row.rookie ?? false,
      sleeper: row.sleeper ?? null,
      game: row.game ?? null,
      sim: row.sim ?? null,
      ppg: row.ppg ?? 0,
    };
  });

  return {
    players,
    plusMinus,
    schedule: said.schedule ?? null,
    perCatch: said.scoredBy?.receptions ?? BOARD_PER_CATCH,
  };
}

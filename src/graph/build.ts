import type {
  Game,
  LeagueGraph,
  Player,
  PlayerStint,
  RosterPosition,
  Team,
} from "./types.js";
import { compareSeasonWeek } from "./types.js";

/** One weekly roster appearance, straight from the source data. */
export interface RosterAppearance {
  playerId: string;
  name: string;
  /** position label as the source spells it, e.g. "T" or "FS" */
  rawPosition: string;
  teamId: string;
  season: number;
  week: number;
  college?: string;
  draftYear?: number;
  draftOverall?: number;
  /** ISO date string when the source has it */
  birthDate?: string;
  /** what he is, which the descriptions in playerVector are built from */
  heightInches?: number;
  weightPounds?: number;
  yearsExperience?: number;
  depthPosition?: string;
  /**
   * What the league had him as that week. ACT is playing, RES is hurt,
   * and EXE is the commissioner's exempt list, which is where a man
   * goes while he is charged with something: he cannot practise or
   * play and nobody knows for how long.
   */
  status?: string;
}

/** nflverse roster labels collapsed into the graph's position groups. */
const positionMap: Record<string, RosterPosition> = {
  QB: "QB",
  RB: "RB",
  FB: "RB",
  WR: "WR",
  TE: "TE",
  T: "OL",
  OT: "OL",
  G: "OL",
  OG: "OL",
  C: "OL",
  OL: "OL",
  DT: "DL",
  NT: "DL",
  DL: "DL",
  DE: "EDGE",
  OLB: "LB",
  ILB: "LB",
  MLB: "LB",
  LB: "LB",
  CB: "CB",
  DB: "CB",
  FS: "S",
  SS: "S",
  S: "S",
  K: "K",
  P: "P",
};

export function mapPosition(raw: string): RosterPosition | undefined {
  return positionMap[raw.toUpperCase()];
}

export interface BuildResult {
  graph: LeagueGraph;
  /** appearances dropped because their position label is unmapped, by label */
  skippedPositions: Map<string, number>;
}

export function buildGraph(
  appearances: RosterAppearance[],
  games: Game[],
): BuildResult {
  const players = new Map<string, Player>();
  const teams = new Map<string, Team>();
  const skippedPositions = new Map<string, number>();
  const byPlayer = new Map<string, RosterAppearance[]>();

  for (const appearance of appearances) {
    const position = mapPosition(appearance.rawPosition);

    if (!position) {
      const label = appearance.rawPosition.toUpperCase();
      skippedPositions.set(label, (skippedPositions.get(label) ?? 0) + 1);
      continue;
    }

    if (!players.has(appearance.playerId)) {
      players.set(appearance.playerId, {
        id: appearance.playerId,
        name: appearance.name,
        position,
        draft:
          appearance.draftYear !== undefined &&
          appearance.draftOverall !== undefined
            ? { season: appearance.draftYear, overall: appearance.draftOverall }
            : undefined,
      });
    }

    const list = byPlayer.get(appearance.playerId) ?? [];
    list.push(appearance);
    byPlayer.set(appearance.playerId, list);

    if (!teams.has(appearance.teamId)) {
      teams.set(appearance.teamId, {
        id: appearance.teamId,
        name: appearance.teamId,
      });
    }
  }

  for (const game of games) {
    for (const teamId of [game.homeTeamId, game.awayTeamId]) {
      if (!teams.has(teamId)) {
        teams.set(teamId, { id: teamId, name: teamId });
      }
    }
  }

  const playerStints: PlayerStint[] = [];

  for (const [playerId, list] of byPlayer) {
    list.sort((a, b) => compareSeasonWeek(a, b));
    playerStints.push(...stintsFor(playerId, list));
  }

  return {
    graph: {
      players,
      teams,
      coaches: new Map(),
      games,
      playerStints,
      coachStints: [],
    },
    skippedPositions,
  };
}

/**
 * Weekly appearances collapse into stints: a run of appearances with
 * the same team is one stint from its first week to its last, and it
 * survives gaps (byes, missed weeks, the offseason) as long as the
 * player resurfaces with the same team.
 */
function stintsFor(
  playerId: string,
  sorted: RosterAppearance[],
): PlayerStint[] {
  const stints: PlayerStint[] = [];
  let current: PlayerStint | undefined;

  for (const appearance of sorted) {
    const at = { season: appearance.season, week: appearance.week };

    if (current && appearance.teamId === current.teamId) {
      current.span.to = at;
      continue;
    }

    if (current) {
      stints.push(current);
    }

    current = {
      playerId,
      teamId: appearance.teamId,
      span: { from: at, to: at },
    };
  }

  if (current) {
    stints.push(current);
  }

  return stints;
}

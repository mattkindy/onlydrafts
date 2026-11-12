/**
 * The league settings the app reads, set by hand where the provider did
 * not say or said it wrong: when the regular season ends, when trades
 * close, and whether anything carries over to next season.
 *
 * What is set here is laid over the league as the provider sent it, at
 * the one place every tab reads the league from, so the trade page, the
 * playoff odds and the keeper sheet all see the same season. Nothing set
 * means the provider's word stands; a setting can always be put back to
 * it. The playoff rules are kept apart, in `playoffRules.ts`, since the
 * standings page edits them on its own.
 */

import type { League } from "./providers.ts";
import { SEASON_WEEKS } from "./availability.ts";

/** whether players carry over: none, the few each team keeps, or all of them */
export type LeagueKind = "redraft" | "keeper" | "dynasty";

export const KIND_SAYS: Record<LeagueKind, string> = {
  redraft: "redraft",
  keeper: "keeper",
  dynasty: "dynasty",
};

const KINDS = Object.keys(KIND_SAYS) as LeagueKind[];

export interface LeagueSettings {
  /** the last week of the regular season */
  lastRegularWeek?: number;
  /** the last week a trade can be made; null is no deadline */
  tradeDeadline?: number | null;
  kind?: LeagueKind;
}

/** where a league's settings are kept */
export const settingsKey = (league: Pick<League, "provider" | "leagueId">) =>
  "settings." + league.provider + "." + league.leagueId;

/** the earliest a regular season can end, and the latest a deadline can be */
const SHORTEST_SEASON = 8;

const week = (n: unknown, low: number, high: number) =>
  typeof n === "number" && Number.isInteger(n) && n >= low && n <= high ? n : undefined;

/**
 * Settings read back from storage, kept only where they still make sense,
 * so an older page's value or a hand edit falls back to the provider's.
 */
export function readSettings(saved: unknown): LeagueSettings {
  if (!saved || typeof saved !== "object") {
    return {};
  }

  const said = saved as Record<string, unknown>;
  const out: LeagueSettings = {};
  const last = week(said["lastRegularWeek"], SHORTEST_SEASON, SEASON_WEEKS - 1);
  const deadline = said["tradeDeadline"] === null
    ? null
    : week(said["tradeDeadline"], 1, SEASON_WEEKS);

  if (last !== undefined) {
    out.lastRegularWeek = last;
  }

  if (deadline !== undefined) {
    out.tradeDeadline = deadline;
  }

  if (KINDS.includes(said["kind"] as LeagueKind)) {
    out.kind = said["kind"] as LeagueKind;
  }

  return out;
}

/** what the provider says of the league's kind, or nothing where it does not */
export function kindSaid(league: League): LeagueKind | null {
  if (league.dynasty) {
    return "dynasty";
  }

  if (league.keepers === true) {
    return "keeper";
  }

  return league.keepers === false ? "redraft" : null;
}

/** the league as the app reads it: the provider's settings with yours over them */
export function withSettings(league: League, settings: LeagueSettings): League {
  const out = { ...league };

  if (settings.lastRegularWeek !== undefined) {
    out.lastRegularWeek = settings.lastRegularWeek;
  }

  if (settings.tradeDeadline !== undefined) {
    out.tradeDeadline = settings.tradeDeadline;
  }

  if (settings.kind) {
    out.dynasty = settings.kind === "dynasty";
    out.keepers = settings.kind !== "redraft";
  }

  return out;
}

/** a setting with the provider's word beside it, for a panel to show both */
export interface Said<T> {
  value: T;
  /** what the provider said, where it said anything */
  provider: T | null;
  /** whether the provider said anything at all; "no deadline" is saying */
  known: boolean;
  /** whether the value is one you set rather than the provider's */
  yours: boolean;
}

/** each setting as it stands, and where it came from */
export function settingsSaid(league: League, settings: LeagueSettings): {
  lastRegularWeek: Said<number>;
  tradeDeadline: Said<number | null>;
  kind: Said<LeagueKind>;
} {
  const kind = kindSaid(league);

  return {
    lastRegularWeek: {
      value: settings.lastRegularWeek ?? league.lastRegularWeek ?? 14,
      provider: league.lastRegularWeek ?? null,
      known: league.lastRegularWeek !== null && league.lastRegularWeek !== undefined,
      yours: settings.lastRegularWeek !== undefined,
    },
    tradeDeadline: {
      value: settings.tradeDeadline !== undefined ? settings.tradeDeadline : league.tradeDeadline ?? null,
      provider: league.tradeDeadline ?? null,
      // a league read before the app asked for the deadline has no field at all
      known: league.tradeDeadline !== undefined,
      yours: settings.tradeDeadline !== undefined,
    },
    kind: {
      value: settings.kind ?? kind ?? "redraft",
      provider: kind,
      known: kind !== null,
      yours: settings.kind !== undefined,
    },
  };
}

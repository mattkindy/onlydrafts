import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { fetchWithRetry } from "./fetchWithRetry.js";
import { normalizeName } from "./names.js";
import {
  canonicalTeam, comingWeek, currentSeason, loadGames, loadWeeklyRosters,
  RAW_DIR,
} from "./nflverse.js";
import { writeAtomically } from "./writeAtomically.js";
import { rosterWeekFor } from "../features/rosterWeek.js";

const API = "https://api.sleeper.app/v1";

interface SleeperPlayer {
  name: string;
  position: string;
}

export interface RawSleeperPlayer {
  full_name?: string;
  position?: string;
  gsis_id?: string | null;
  /** the club he is on, null for a free agent or a retired player */
  team?: string | null;
  injury_status?: string | null;
}

const PLAYER_FILE = join(RAW_DIR, "sleeper_players.json");

async function downloadSleeperPlayerFile(): Promise<
  Record<string, RawSleeperPlayer>
> {
  const response = await fetchWithRetry(`${API}/players/nfl`, {
    label: "sleeper players",
  });

  if (!response.ok) {
    throw new Error(`sleeper players returned ${response.status}`);
  }

  const raw = (await response.json()) as Record<string, RawSleeperPlayer>;
  await writeAtomically(PLAYER_FILE, JSON.stringify(raw));
  return raw;
}

/** the whole player file, downloaded once and kept on disk (about 15MB) */
async function loadSleeperPlayerFile(): Promise<
  Record<string, RawSleeperPlayer>
> {
  try {
    return JSON.parse(await readFile(PLAYER_FILE, "utf8"));
  } catch {
    return downloadSleeperPlayerFile();
  }
}

/** sleeper player id -> name and position */
export async function fetchSleeperPlayers(): Promise<Map<string, SleeperPlayer>> {
  const raw = await loadSleeperPlayerFile();
  const players = new Map<string, SleeperPlayer>();

  for (const [id, p] of Object.entries(raw)) {
    if (p.full_name && p.position) {
      players.set(id, { name: p.full_name, position: p.position });
    }
  }

  return players;
}

const PLAYER_IDS_URL =
  "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv";

const CROSSWALK_FILE = join(RAW_DIR, "db_playerids.csv");

async function downloadCrosswalk(): Promise<string> {
  const response = await fetchWithRetry(PLAYER_IDS_URL, {
    label: "player id crosswalk",
  });

  if (!response.ok) {
    throw new Error(`player id crosswalk returned ${response.status}`);
  }

  const text = await response.text();
  await writeAtomically(CROSSWALK_FILE, text);
  return text;
}

/**
 * The downloaded text, or the copy on disk when the download fails and a
 * copy exists, with a warning. With no copy on disk the download's error
 * is thrown.
 */
export async function freshOrCached(
  download: () => Promise<string>,
  readCached: () => Promise<string>,
  label: string,
): Promise<string> {
  try {
    return await download();
  } catch (error) {
    const cached = await readCached().catch(() => "");

    if (!cached) {
      throw error;
    }

    console.warn(`${label} did not download, using the copy on disk: ${String(error)}`);
    return cached;
  }
}

let crosswalkThisRun: Promise<Record<string, string>[]> | undefined;

/**
 * The DynastyProcess id crosswalk, downloaded again once per process.
 * Players who came into the league lately get their Sleeper id in it
 * during the season, and in CI the copy on disk comes back from a cache
 * that nothing else replaces. A stale copy is still better than failing
 * the whole refresh.
 */
function loadPlayerIdCrosswalk(): Promise<Record<string, string>[]> {
  crosswalkThisRun ??= freshOrCached(
    downloadCrosswalk,
    () => readFile(CROSSWALK_FILE, "utf8"),
    "the player id crosswalk",
  ).then(parseCsv);

  return crosswalkThisRun;
}

/**
 * sleeper player id -> nflverse gsis id. Sleeper keeps its own ids and
 * everything else here keys players by gsis, so anything from Sleeper has
 * to come through this before it can be joined.
 *
 * Sleeper's own player file has a gsis_id field, but it is empty for
 * anyone who came into the league in the last few years, which is a third
 * of the players we care about. The DynastyProcess crosswalk covers them, so
 * it goes first and Sleeper's own field fills whatever it misses. A player
 * neither of them links is matched by name against this week's roster.
 */
export async function fetchSleeperGsisIds(): Promise<Map<string, string>> {
  return gsisIdsFrom(await loadSleeperPlayerFile());
}

async function gsisIdsFrom(
  raw: Record<string, RawSleeperPlayer>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  // Sleeper writes some ids with a leading space, which no gsis key
  // anywhere else has, so an untrimmed one never matches
  for (const [id, p] of Object.entries(raw)) {
    const gsisId = p.gsis_id?.trim();

    if (gsisId) {
      ids.set(id, gsisId);
    }
  }

  for (const row of await loadPlayerIdCrosswalk()) {
    const sleeperId = row["sleeper_id"]?.trim();
    const gsisId = row["gsis_id"]?.trim();

    // the crosswalk writes NA for a player it has no gsis id for, which
    // would otherwise replace the one Sleeper's own file gave him
    if (sleeperId && gsisId && gsisId !== "NA") {
      ids.set(sleeperId, gsisId);
    }
  }

  for (const [sleeperId, gsisId] of linkByName(raw, ids, await rosterThisWeek())) {
    ids.set(sleeperId, gsisId);
    logLinkOnce(sleeperId, raw[sleeperId]?.full_name ?? "", gsisId);
  }

  return ids;
}

/** the parts of a weekly roster row a name link needs */
export interface RosterPlayer {
  playerId: string;
  name: string;
  teamId: string;
  rawPosition: string;
}

const rosterKey = (name: string, team: string, position: string) =>
  `${normalizeName(name)}|${canonicalTeam(team)}|${position}`;

/**
 * sleeper id -> gsis id for players neither Sleeper nor the crosswalk
 * links, matched on normalized name, club and position against the
 * roster. A link is made only when exactly one roster player matches,
 * exactly one unlinked Sleeper player matches him, and no other Sleeper
 * id already has his gsis id.
 */
export function linkByName(
  raw: Record<string, RawSleeperPlayer>,
  linked: Map<string, string>,
  roster: RosterPlayer[],
): Map<string, string> {
  const taken = new Set(linked.values());
  const onRoster = new Map<string, Set<string>>();

  for (const row of roster) {
    const key = rosterKey(row.name, row.teamId, row.rawPosition);
    onRoster.set(key, (onRoster.get(key) ?? new Set()).add(row.playerId));
  }

  const claims = new Map<string, string[]>();

  for (const [sleeperId, player] of Object.entries(raw)) {
    if (linked.has(sleeperId) || !player.full_name || !player.team) {
      continue;
    }

    const matches = onRoster.get(
      rosterKey(player.full_name, player.team, player.position ?? ""),
    );
    const gsisId = matches?.size === 1 ? [...matches][0] : undefined;

    if (!gsisId || taken.has(gsisId)) {
      continue;
    }

    claims.set(gsisId, [...(claims.get(gsisId) ?? []), sleeperId]);
  }

  const links = new Map<string, string>();

  for (const [gsisId, sleeperIds] of claims) {
    if (sleeperIds.length === 1) {
      links.set(sleeperIds[0]!, gsisId);
    }
  }

  return links;
}

/**
 * The current season's roster for the week the refresh builds, or the
 * latest week the file has before it. No roster file means no name links.
 */
async function rosterThisWeek(): Promise<RosterPlayer[]> {
  const season = currentSeason();
  const rosters = await loadWeeklyRosters(season).catch(() => []);

  if (rosters.length === 0) {
    return [];
  }

  const games = await loadGames().catch(() => []);
  const week = rosterWeekFor(
    rosters.map((row) => row.week), comingWeek(games, season),
  );

  return rosters.filter((row) => row.week === week);
}

const linksLogged = new Set<string>();

// the ids are read more than once a run, and a wrong match should be
// easy to spot in the log without reading it twice
function logLinkOnce(sleeperId: string, name: string, gsisId: string): void {
  if (linksLogged.has(sleeperId)) {
    return;
  }

  linksLogged.add(sleeperId);
  console.log(
    `linked Sleeper ${sleeperId} (${name}) to ${gsisId} by name, club and position`,
  );
}

export interface SleeperInjury {
  status: string;
  /** his club as Sleeper spells it */
  team: string;
}

/**
 * gsis id -> Sleeper's injury status, for every player on a club who has
 * one. The crosswalk gives a few gsis ids two Sleeper ids, and the first
 * status found for him is kept.
 */
export function injuryStatuses(
  raw: Record<string, RawSleeperPlayer>,
  gsisBySleeperId: Map<string, string>,
): Map<string, SleeperInjury> {
  const statuses = new Map<string, SleeperInjury>();

  for (const [sleeperId, player] of Object.entries(raw)) {
    const gsisId = gsisBySleeperId.get(sleeperId);
    const status = player.injury_status?.trim();
    const team = player.team?.trim();

    if (!gsisId || !status || !team || statuses.has(gsisId)) {
      continue;
    }

    statuses.set(gsisId, { status, team });
  }

  return statuses;
}

/**
 * Every player's injury status as Sleeper has it right now. The copy of the
 * player file on disk is kept for weeks, so this downloads it again and
 * replaces the copy, which also brings the gsis crosswalk up to date.
 */
export async function fetchSleeperInjuryStatuses(): Promise<
  Map<string, SleeperInjury>
> {
  const raw = await downloadSleeperPlayerFile();

  return injuryStatuses(raw, await gsisIdsFrom(raw));
}

interface LeagueRoster {
  ownerName: string;
  playerIds: string[];
}

export async function fetchLeagueRosters(
  leagueId: string,
): Promise<LeagueRoster[]> {
  const [rostersRes, usersRes] = await Promise.all([
    fetchWithRetry(`${API}/league/${leagueId}/rosters`),
    fetchWithRetry(`${API}/league/${leagueId}/users`),
  ]);

  if (!rostersRes.ok || !usersRes.ok) {
    throw new Error(
      `sleeper league ${leagueId} returned ${rostersRes.status}/${usersRes.status}`,
    );
  }

  const rosters = (await rostersRes.json()) as {
    owner_id: string;
    players: string[] | null;
  }[];
  const users = (await usersRes.json()) as {
    user_id: string;
    display_name: string;
  }[];
  const nameOf = new Map(users.map((u) => [u.user_id, u.display_name]));

  return rosters.map((r) => ({
    ownerName: nameOf.get(r.owner_id) ?? r.owner_id,
    playerIds: r.players ?? [],
  }));
}

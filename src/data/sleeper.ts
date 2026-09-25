import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { fetchWithRetry } from "./fetchWithRetry.js";
import { RAW_DIR } from "./nflverse.js";
import { writeAtomically } from "./writeAtomically.js";

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
 * it goes first and Sleeper's own field fills whatever it misses.
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

  return ids;
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

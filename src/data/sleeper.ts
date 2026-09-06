import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR } from "./nflverse.js";

const API = "https://api.sleeper.app/v1";

export interface SleeperPlayer {
  name: string;
  position: string;
}

interface RawSleeperPlayer {
  full_name?: string;
  position?: string;
  gsis_id?: string | null;
}

/** the whole player file, downloaded once and kept on disk (about 5MB) */
async function loadSleeperPlayerFile(): Promise<
  Record<string, RawSleeperPlayer>
> {
  const cachePath = join(RAW_DIR, "sleeper_players.json");

  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    const response = await fetch(`${API}/players/nfl`);

    if (!response.ok) {
      throw new Error(`sleeper players returned ${response.status}`);
    }

    const raw = (await response.json()) as Record<string, RawSleeperPlayer>;
    await writeFile(cachePath, JSON.stringify(raw));
    return raw;
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

/** the DynastyProcess id crosswalk, cached on disk like the player file */
async function loadPlayerIdCrosswalk(): Promise<Record<string, string>[]> {
  const cachePath = join(RAW_DIR, "db_playerids.csv");

  try {
    return parseCsv(await readFile(cachePath, "utf8"));
  } catch {
    const response = await fetch(PLAYER_IDS_URL);

    if (!response.ok) {
      throw new Error(`player id crosswalk returned ${response.status}`);
    }

    const text = await response.text();
    await writeFile(cachePath, text);
    return parseCsv(text);
  }
}

/**
 * sleeper player id -> nflverse gsis id. Sleeper keeps its own ids and
 * everything else here keys players by gsis, so anything from Sleeper has
 * to come through this before it can be joined.
 *
 * Sleeper's own player file has a gsis_id field, but it is empty for
 * anyone who came into the league in the last few years, which is a third
 * of the men we care about. The DynastyProcess crosswalk covers them, so
 * it goes first and Sleeper's own field fills whatever it misses.
 */
export async function fetchSleeperGsisIds(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const raw = await loadSleeperPlayerFile();

  for (const [id, p] of Object.entries(raw)) {
    if (p.gsis_id) {
      ids.set(id, p.gsis_id);
    }
  }

  for (const row of await loadPlayerIdCrosswalk()) {
    const sleeperId = row["sleeper_id"];
    const gsisId = row["gsis_id"];

    if (sleeperId && gsisId) {
      ids.set(sleeperId, gsisId);
    }
  }

  return ids;
}

export interface LeagueRoster {
  ownerName: string;
  playerIds: string[];
}

export async function fetchLeagueRosters(
  leagueId: string,
): Promise<LeagueRoster[]> {
  const [rostersRes, usersRes] = await Promise.all([
    fetch(`${API}/league/${leagueId}/rosters`),
    fetch(`${API}/league/${leagueId}/users`),
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

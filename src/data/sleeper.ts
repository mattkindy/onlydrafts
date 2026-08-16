import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RAW_DIR } from "./nflverse.js";

const API = "https://api.sleeper.app/v1";

export interface SleeperPlayer {
  name: string;
  position: string;
}

/** sleeper player id -> name and position, cached on disk (about 5MB) */
export async function fetchSleeperPlayers(): Promise<Map<string, SleeperPlayer>> {
  const cachePath = join(RAW_DIR, "sleeper_players.json");
  let raw: Record<string, { full_name?: string; position?: string }>;

  try {
    raw = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    const response = await fetch(`${API}/players/nfl`);

    if (!response.ok) {
      throw new Error(`sleeper players returned ${response.status}`);
    }

    raw = (await response.json()) as typeof raw;
    await writeFile(cachePath, JSON.stringify(raw));
  }

  const players = new Map<string, SleeperPlayer>();

  for (const [id, p] of Object.entries(raw)) {
    if (p.full_name && p.position) {
      players.set(id, { name: p.full_name, position: p.position });
    }
  }

  return players;
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

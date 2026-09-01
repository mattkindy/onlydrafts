/**
 * Where a league comes from.
 *
 * Sleeper and ESPN both describe a league differently, so each one is
 * read into the same shape and the rest of the page never asks which
 * site it came from.
 */

import { normalizeName, stored, keep } from "./store.ts";
import type { Pays } from "./scoring.ts";

export interface Man {
  name: string;
  key: string;
  pos?: string;
}

export interface Roster {
  owner: string;
  /** the rounds this team still holds */
  picks: number[];
  keys: Man[];
}

export interface League {
  provider: "sleeper" | "espn";
  leagueId: string;
  name: string;
  size: number;
  pays: Pays;
  slots: string[] | null;
  userId: string;
  team: string;
  members: Record<string, string>;
  myRoster: Man[];
  myPicks: number[];
  draftSlot: number | null;
  snake: boolean;
  allRosters: Roster[];
}

export interface Provider {
  label: string;
  asks: string;
  wants: string;
  leaguesFor: (who: string, season: number) => Promise<League[]>;
  /** espn keeps a draft behind its own view, so only Sleeper is live */
  draftNow: ((league: League) => Promise<DraftNow | null>) | null;
}

export interface DraftNow {
  draft: {
    settings?: { teams?: number; rounds?: number };
    type?: string;
    draft_order?: Record<string, number>;
    status?: string;
  };
  picks: {
    player_id: string;
    picked_by: string;
    roster_id?: number;
    pick_no: number;
    is_keeper?: boolean;
  }[];
}

const ROUNDS = 15;

/** ours, unless somebody has put up their own */
export const ESPN_WORKER = "https://depth-chart-espn.matt-kindy-ii.workers.dev";

const SLEEPER = "https://api.sleeper.app/v1";
const ask = (path: string) => fetch(SLEEPER + path).then((r) => r.json());

/**
 * What ESPN calls each thing it pays for. Its scoring comes back as
 * numbered items, so the numbers are named here and anything without a
 * name is left alone rather than guessed at.
 */
const ESPN_STATS: Record<number, string> = {
  3: "pass_yd", 4: "pass_td", 20: "int", 24: "rush_yd", 25: "rush_td",
  42: "rec_yd", 43: "rec_td", 53: "rec", 72: "fum_lost", 74: "xpm",
  77: "fgm_0_19", 80: "fgm_20_29", 83: "fgm_30_39", 86: "fgm_40_49",
  88: "fgm_50p", 89: "fgmiss_0_19", 99: "sack", 95: "int", 96: "fum_rec",
  97: "blk_kick", 98: "safe", 101: "def_td",
};

/** and what it calls the slots a lineup is made of */
const ESPN_SLOTS: Record<number, string> = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DEF", 17: "K",
  23: "FLEX", 7: "FLEX",
};

export interface SleeperMan {
  n: string;
  p: string;
  /** what the league office says: questionable, out, ir, and the rest */
  hurt?: string;
  /** and where, since a hamstring and a thumb are different news */
  part?: string;
}

export type SleeperMen = Record<string, SleeperMan>;

/** Sleeper's whole player file, trimmed and kept for the day */
let sleeperMen: SleeperMen | null = null;

export async function sleeperPlayers() {
  if (sleeperMen) {
    return sleeperMen;
  }

  /**
   * A day, because the list gains men every week of the year: rookies
   * at the draft, signings all summer. The old cache never expired and
   * a browser from last season silently dropped every newer man from
   * the draft it was watching.
   */
  const cached = stored<{
    at: number; men: SleeperMen;
  } | null>("players.v4", null);

  if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) {
    sleeperMen = cached.men;

    return cached.men;
  }

  const raw = await ask("/players/nfl") as Record<string, {
    full_name?: string; position?: string;
    injury_status?: string | null; injury_body_part?: string | null;
  }>;
  const trimmed: SleeperMen = {};

  for (const [id, p] of Object.entries(raw)) {
    if (p.full_name && p.position) {
      trimmed[id] = {
        n: p.full_name,
        p: p.position,
        ...(p.injury_status ? { hurt: p.injury_status } : {}),
        ...(p.injury_body_part ? { part: p.injury_body_part } : {}),
      };
    }
  }

  keep("players.v4", { at: Date.now(), men: trimmed });
  sleeperMen = trimmed;

  return trimmed;
}

interface SleeperRoster {
  roster_id: number;
  owner_id: string;
  players?: string[];
}

/**
 * Which rounds each team still holds.
 *
 * Keeping a man costs the pick he is priced at, so a team without that
 * round cannot keep him at any price. A pick dealt away and later
 * bought back reads as both, so it stays put.
 */
function roundsHeldBy(
  rosters: SleeperRoster[],
  traded: { season: string | number; round: number; roster_id: number; owner_id: number }[],
  season: string,
) {
  const picksOf = new Map(rosters.map((r) => [
    r.roster_id,
    new Map(Array.from({ length: ROUNDS }, (_, i) => [i + 1, 1])),
  ]));

  for (const pick of traded.filter((t) => String(t.season) === season)) {
    if (pick.roster_id === pick.owner_id) {
      continue;
    }

    const from = picksOf.get(pick.roster_id);
    const to = picksOf.get(pick.owner_id);

    if (from) {
      from.set(pick.round, (from.get(pick.round) ?? 0) - 1);
    }

    if (to) {
      to.set(pick.round, (to.get(pick.round) ?? 0) + 1);
    }
  }

  return (id: number) =>
    [...(picksOf.get(id) ?? new Map<number, number>())]
      .filter(([, n]) => n > 0)
      .map(([round]) => round)
      .sort((a, b) => a - b);
}

async function sleeperLeagues(username: string): Promise<League[]> {
  const user = await ask("/user/" + encodeURIComponent(username));

  if (!user || !user.user_id) {
    throw new Error("Sleeper has no user by that name.");
  }

  const state = await ask("/state/nfl");
  const found = await ask(
    "/user/" + user.user_id + "/leagues/nfl/" + state.season,
  );
  const men = await sleeperPlayers();
  const out: League[] = [];

  for (const lg of (found ?? []) as Record<string, any>[]) {
    const [rosters, users, traded, drafts] = await Promise.all([
      ask("/league/" + lg["league_id"] + "/rosters"),
      ask("/league/" + lg["league_id"] + "/users"),
      ask("/league/" + lg["league_id"] + "/traded_picks").catch(() => []),
      ask("/league/" + lg["league_id"] + "/drafts").catch(() => []),
    ]);
    const held = roundsHeldBy(rosters, traded ?? [], String(lg["season"]));
    const mine = (rosters as SleeperRoster[])
      .find((r) => r.owner_id === user.user_id);
    const nameOf = new Map<string, string>(
      (users as { user_id: string; display_name: string }[])
        .map((u) => [u.user_id, u.display_name]),
    );
    const manOf = (id: string) => men[id];

    out.push({
      provider: "sleeper",
      leagueId: String(lg["league_id"]),
      name: String(lg["name"]),
      size: Number(lg["total_rosters"]),
      pays: (lg["scoring_settings"] ?? {}) as Pays,
      slots: (lg["roster_positions"] ?? null) as string[] | null,
      userId: user.user_id,
      team: nameOf.get(user.user_id) ?? username,
      members: Object.fromEntries(nameOf),
      myRoster: (mine?.players ?? [])
        .map(manOf)
        .filter((p): p is { n: string; p: string } => Boolean(p))
        .map((p) => ({ name: p.n, key: normalizeName(p.n), pos: p.p })),
      myPicks: held(mine ? mine.roster_id : -1),
      // where you sit in the order, so a keeper is priced against the
      // pick you would actually make rather than the middle of a round
      draftSlot: drafts?.[0]?.draft_order?.[user.user_id] ?? null,
      snake: !drafts?.[0] || drafts[0].type === "snake",
      allRosters: (rosters as SleeperRoster[]).map((r) => ({
        owner: nameOf.get(r.owner_id) ?? r.owner_id,
        picks: held(r.roster_id),
        keys: (r.players ?? [])
          .map(manOf)
          .filter((p): p is { n: string; p: string } => Boolean(p))
          .map((p) => ({ name: p.n, key: normalizeName(p.n), pos: p.p })),
      })),
    });
  }

  return out;
}

/** the draft as Sleeper has it right now, or nothing before it exists */
async function sleeperDraft(league: League): Promise<DraftNow | null> {
  const drafts = await ask("/league/" + league.leagueId + "/drafts");

  if (!drafts?.[0]) {
    return null;
  }

  return {
    draft: await ask("/draft/" + drafts[0].draft_id),
    picks: await ask("/draft/" + drafts[0].draft_id + "/picks"),
  };
}

export class NeedsEspnCookies extends Error {}

/**
 * ESPN keeps a private league behind the cookies your sign in leaves
 * on espn.com, a browser sends those only to espn.com, and javascript
 * cannot set them by hand. The relay can, so its address and the two
 * cookies stay in this browser and go nowhere else.
 */
async function throughTheWorker(leagueId: string, season: number) {
  const where = stored("espnWorker", "") || ESPN_WORKER;
  const swid = stored("espnSwid", "");
  const s2 = stored("espnS2", "");

  if (!swid || !s2) {
    throw new NeedsEspnCookies(
      "That ESPN league is private, so it needs your own two espn cookies.",
    );
  }

  const said = await fetch(
    where.replace(/\/+$/, "") + "/espn/" + encodeURIComponent(leagueId) +
      "?season=" + season,
    { headers: { "x-espn-swid": swid, "x-espn-s2": s2 } },
  ).then((r) => r.json()).catch(() => null);

  if (!said || said.error) {
    // stale cookies look exactly like never having had any, so the page
    // says what to do rather than what went wrong
    throw new NeedsEspnCookies(
      said?.error ?? "the relay could not reach ESPN",
    );
  }

  keep("espnAsked", new Date().toISOString().slice(0, 10));

  return said;
}

/**
 * Take the two cookies out of whatever was pasted. What arrives might
 * be the whole cookie line off the site, or the two values on their
 * own, and either is fine.
 */
export function espnCookiesFrom(pasted: string) {
  const swid = pasted.match(/SWID=?\s*[:=]?\s*(\{[^;"\s]+\})/i) ??
    pasted.match(/(\{[0-9A-F-]{30,}\})/i);
  const s2 = pasted.match(/espn_s2=?\s*[:=]?\s*["']?([A-Za-z0-9%_.-]{80,})/i);

  return { swid: swid?.[1] ?? "", s2: s2?.[1] ?? "" };
}

async function espnLeagues(leagueId: string, season: number): Promise<League[]> {
  const at = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" +
    season + "/segments/0/leagues/" + encodeURIComponent(leagueId) +
    "?view=mTeam&view=mSettings&view=mRoster&view=mDraftDetail";
  /**
   * A page here cannot read the cookies espn.com keeps, and never will:
   * that rule is what stops any site reading your bank session. It can
   * ask the browser to send them, and whether the browser agrees is
   * ESPN's choice. So a private league is tried this way first, in case
   * it opens for nothing, and only then does it come down to the relay.
   */
  const answered = await fetch(at, { credentials: "include" }).catch(() => null);
  const said = answered?.ok
    ? await answered.json()
    : await throughTheWorker(leagueId, season);

  if (!said?.teams) {
    throw new Error("ESPN has no league with that id for this season.");
  }

  const settings = said.settings ?? {};
  const pays: Pays = {};

  for (const item of settings.scoringSettings?.scoringItems ?? []) {
    const named = ESPN_STATS[item.statId as number];

    if (named) {
      pays[named] = item.points ?? 0;
    }
  }

  const slots: string[] = [];

  for (const [slot, howMany] of Object.entries<number>(
    settings.rosterSettings?.lineupSlotCounts ?? {},
  )) {
    const named = ESPN_SLOTS[Number(slot)];

    for (let i = 0; named && i < howMany; i++) {
      slots.push(named);
    }
  }

  interface EspnTeam {
    id: number;
    name?: string;
    location?: string;
    nickname?: string;
    draftDayProjectedRank?: number;
    roster?: { entries?: { playerPoolEntry?: { player?: {
      fullName?: string; defaultPositionId?: number;
    } } }[] };
  }

  const teams = said.teams as EspnTeam[];
  const nameOf = (team: EspnTeam) =>
    (team.name ?? [team.location, team.nickname].filter(Boolean).join(" ")).trim();
  const menOf = (team: EspnTeam): Man[] => (team.roster?.entries ?? [])
    .map((e) => e.playerPoolEntry?.player)
    .filter((p): p is { fullName: string; defaultPositionId?: number } =>
      Boolean(p?.fullName))
    .map((p) => ({
      name: p.fullName,
      key: normalizeName(p.fullName),
      pos: ESPN_SLOTS[p.defaultPositionId ?? -1] ?? "",
    }));
  const everyRound = Array.from({ length: ROUNDS }, (_, i) => i + 1);

  // every team is offered, since ESPN will not say which one is yours
  // unless you are signed in to it
  return teams.map((team) => ({
    provider: "espn" as const,
    leagueId: String(leagueId),
    name: (settings.name ?? "ESPN league") + " (" + nameOf(team) + ")",
    size: teams.length,
    pays,
    slots,
    userId: String(team.id),
    team: nameOf(team),
    members: Object.fromEntries(teams.map((t) => [String(t.id), nameOf(t)])),
    myRoster: menOf(team),
    myPicks: everyRound,
    draftSlot: team.draftDayProjectedRank ?? null,
    snake: true,
    allRosters: teams.map((t) => ({
      owner: nameOf(t), picks: everyRound, keys: menOf(t),
    })),
  }));
}

export const PROVIDERS: Record<string, Provider> = {
  sleeper: {
    label: "Sleeper",
    asks: "sleeper user",
    wants: "username",
    leaguesFor: (who) => sleeperLeagues(who),
    draftNow: sleeperDraft,
  },
  espn: {
    label: "ESPN",
    asks: "espn league id",
    wants: "league id",
    leaguesFor: espnLeagues,
    draftNow: null,
  },
};

export const providerOf = (league: { provider?: string } | null) =>
  PROVIDERS[league?.provider ?? "sleeper"]!;

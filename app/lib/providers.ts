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
  /** which season this is, since watching the draft has to ask again */
  season: number;
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
    round?: number;
    draft_slot?: number;
    /**
     * Who he is, when the provider already knows. Sleeper hands back an
     * id and the page looks it up in the file it keeps; ESPN numbers its
     * own men and there is no such file, so its picks arrive named.
     */
    name?: string;
    position?: string;
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
const ESPN_STATS: Record<number, string[]> = {
  3: ["pass_yd"], 4: ["pass_td"], 20: ["pass_int"], 24: ["rush_yd"],
  25: ["rush_td"], 42: ["rec_yd"], 43: ["rec_td"], 53: ["rec"],
  72: ["fum_lost"],
  // running one in, catching one and throwing one all pay the same
  // here, which is the one rate the board keeps for two point plays
  19: ["rush_2pt"], 26: ["rush_2pt"], 44: ["rush_2pt"],
  /**
   * Kicking comes in threes, made then attempted then missed, and ESPN
   * counts everything under forty yards as one band where the board
   * splits it three ways. Its rolled up totals, every field goal and
   * every one from fifty out, are skipped: pricing those as well as the
   * bands they are made of would pay a long kick twice.
   */
  86: ["xpm"], 88: ["xpmiss"],
  80: ["fgm_0_19", "fgm_20_29", "fgm_30_39"],
  77: ["fgm_40_49"], 198: ["fgm_50_59"], 201: ["fgm_60p"],
  85: [
    "fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39",
    "fgmiss_40_49", "fgmiss_50_59", "fgmiss_60p",
  ],
  82: ["fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39"],
  79: ["fgmiss_40_49"], 200: ["fgmiss_50_59"], 203: ["fgmiss_60p"],
  99: ["sack"], 95: ["int"], 96: ["fum_rec"], 97: ["blk_kick"],
  98: ["safe"],
  // ESPN prices a defence's touchdown once for each way of scoring one,
  // and the board counts them all as the same thing
  101: ["def_td"], 93: ["def_td"], 102: ["def_td"], 103: ["def_td"],
  104: ["def_td"],
  89: ["pts_allow_0"], 90: ["pts_allow_1_6"], 91: ["pts_allow_7_13"],
  122: ["pts_allow_21_27"], 123: ["pts_allow_28_34"],
};

/**
 * What ESPN pays for holding a side to a score when nobody has said
 * otherwise. It leaves out any item still sitting at its own default,
 * and without these the board would reach for a ladder built to
 * Sleeper's numbers and hand every defence points it never earned.
 */
const ESPN_PTS_ALLOWED: Record<number, number> = {
  89: 5, 90: 4, 91: 3, 92: 1, 121: 0, 122: -1, 123: -3, 124: -5, 125: -6,
};

/**
 * The two sites cut the middle and the top of that ladder in different
 * places, so where two of ESPN's steps cover one of the board's the
 * price is split between them.
 */
const ESPN_STRADDLES: [number, number, string][] = [
  [92, 121, "pts_allow_14_20"],
  [124, 125, "pts_allow_35p"],
];

/** and what it calls the slots a lineup is made of */
const ESPN_SLOTS: Record<number, string> = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DEF", 17: "K",
  23: "FLEX", 7: "FLEX",
};

/**
 * What position a man plays. ESPN numbers a lineup slot and a position
 * separately and the two disagree: 4 is the wide receiver slot but a
 * tight end, so reading one with the other quietly mislabels people.
 */
const ESPN_POSITIONS: Record<number, string> = {
  1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF",
};

/** ESPN's number for each pro team, against the code the board uses */
const ESPN_TEAMS: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LA",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA",
  27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

/**
 * What to call an ESPN man.
 *
 * A defence there is "Falcons D/ST" under a made up id of -16000 minus
 * its pro team, while the board goes by team code. Left alone the two
 * never match, so a defence would stay on the board after it was taken.
 */
const espnNameOf = (id: number, fullName: string, pos: string) =>
  pos === "DEF" ? ESPN_TEAMS[-id - 16000] ?? fullName : fullName;

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

export interface EspnMan {
  n: string;
  p: string;
}

export type EspnMen = Record<string, EspnMan>;

/** ESPN's whole player list, trimmed and kept for the day */
let espnMen: EspnMen | null = null;

/**
 * Everyone ESPN has, by the numbers it gives them.
 *
 * A pick arrives as a number and nothing else. The rosters in the same
 * answer name only the men already handed out, which before a draft is
 * nobody, so the board would sit blank until somebody picked. This is
 * the list the public site reads and it needs no cookie.
 */
export async function espnPlayers(season: number): Promise<EspnMen> {
  if (espnMen) {
    return espnMen;
  }

  const key = "espnPlayers." + season;
  const cached = stored<{ at: number; men: EspnMen } | null>(key, null);

  if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) {
    espnMen = cached.men;

    return cached.men;
  }

  const answered = await fetch(
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" +
      season + "/players?scoringPeriodId=0&view=players_wl",
    // asked without a limit it returns only the first fifty men
    { headers: { "x-fantasy-filter": '{"players":{"limit":4000}}' } },
  );

  if (!answered.ok) {
    throw new Error("ESPN would not hand over its player list.");
  }

  const raw = await answered.json() as {
    id: number; fullName?: string; defaultPositionId?: number;
  }[];
  const trimmed: EspnMen = {};

  for (const man of raw) {
    const pos = ESPN_POSITIONS[man.defaultPositionId ?? -1];

    if (man.fullName && pos) {
      trimmed[man.id] = { n: espnNameOf(man.id, man.fullName, pos), p: pos };
    }
  }

  keep(key, { at: Date.now(), men: trimmed });
  espnMen = trimmed;

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
      season: Number(lg["season"] ?? state.season),
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

/**
 * One league, however it has to be reached.
 *
 * A page here cannot read the cookies espn.com keeps, and never will:
 * that rule is what stops any site reading your bank session. It can
 * ask the browser to send them, and whether the browser agrees is
 * ESPN's choice. So a private league is tried this way first, in case
 * it opens for nothing, and only then does it come down to the relay.
 */
async function espnAnswer(leagueId: string, season: number) {
  const at = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" +
    season + "/segments/0/leagues/" + encodeURIComponent(leagueId) +
    "?view=mTeam&view=mSettings&view=mRoster&view=mDraftDetail";
  const answered = await fetch(at, { credentials: "include" }).catch(() => null);

  return answered?.ok
    ? await answered.json()
    : await throughTheWorker(leagueId, season);
}

interface EspnTeam {
  id: number;
  name?: string;
  location?: string;
  nickname?: string;
  roster?: { entries?: { playerId?: number; playerPoolEntry?: { player?: {
    id?: number; fullName?: string; defaultPositionId?: number;
  } } }[] };
}

interface EspnPick {
  playerId: number;
  teamId: number;
  roundId: number;
  roundPickNumber: number;
  overallPickNumber: number;
  keeper?: boolean;
  reservedForKeeper?: boolean;
}

/**
 * Which slot each team picks from.
 *
 * ESPN lists the teams in the order they pick, so a team's place in
 * that list is its slot. The list gets shuffled an hour before the
 * draft starts, so it is read fresh every time rather than kept. Round
 * one gives the same order, and is used if the list is missing.
 */
function espnOrder(said: {
  settings?: { draftSettings?: { pickOrder?: number[] } };
  draftDetail?: { picks?: EspnPick[] };
}): Record<string, number> {
  const order: Record<string, number> = {};

  for (const [i, teamId] of (said.settings?.draftSettings?.pickOrder ?? [])
    .entries()) {
    order[String(teamId)] = i + 1;
  }

  if (Object.keys(order).length) {
    return order;
  }

  for (const pick of said.draftDetail?.picks ?? []) {
    if (pick.roundId === 1) {
      order[String(pick.teamId)] = pick.roundPickNumber;
    }
  }

  return order;
}

async function espnLeagues(leagueId: string, season: number): Promise<League[]> {
  const said = await espnAnswer(leagueId, season);

  if (!said?.teams) {
    throw new Error("ESPN has no league with that id for this season.");
  }

  const settings = said.settings ?? {};
  const worth = new Map<number, number>();

  for (const item of (settings.scoringSettings?.scoringItems ?? []) as
    { statId: number; points?: number }[]) {
    worth.set(item.statId, item.points ?? 0);
  }

  // only for a league that prices the ladder at all, so one that pays a
  // defence nothing for a score is left paying nothing
  if (Object.keys(ESPN_PTS_ALLOWED).some((id) => worth.has(Number(id)))) {
    for (const [id, fallback] of Object.entries(ESPN_PTS_ALLOWED)) {
      if (!worth.has(Number(id))) {
        worth.set(Number(id), fallback);
      }
    }
  }

  const pays: Pays = {};

  for (const [id, named] of Object.entries(ESPN_STATS)) {
    const paid = worth.get(Number(id));

    if (paid !== undefined) {
      for (const category of named) {
        pays[category] = paid;
      }
    }
  }

  for (const [low, high, category] of ESPN_STRADDLES) {
    const under = worth.get(low);
    const over = worth.get(high);

    if (under !== undefined && over !== undefined) {
      pays[category] = (under + over) / 2;
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

  const teams = said.teams as EspnTeam[];
  const nameOf = (team: EspnTeam) =>
    (team.name ?? [team.location, team.nickname].filter(Boolean).join(" ")).trim();
  // a roster entry usually spells the man out, but sometimes gives only
  // his number, and then the player list is the only way to know him
  const men = await espnPlayers(season).catch(() => ({} as EspnMen));
  const menOf = (team: EspnTeam): Man[] => (team.roster?.entries ?? [])
    .map((e) => {
      const man = e.playerPoolEntry?.player;
      const id = man?.id ?? e.playerId;
      const listed = id ? men[id] : undefined;

      if (man?.fullName) {
        const pos = ESPN_POSITIONS[man.defaultPositionId ?? -1] ??
          listed?.p ?? "";

        return { name: espnNameOf(id!, man.fullName, pos), pos };
      }

      return listed ? { name: listed.n, pos: listed.p } : null;
    })
    .filter((m): m is { name: string; pos: string } => Boolean(m))
    .map((m) => ({ name: m.name, key: normalizeName(m.name), pos: m.pos }));
  const rounds = Math.max(
    ...(said.draftDetail?.picks ?? []).map((p: EspnPick) => p.roundId),
    ROUNDS,
  );
  const everyRound = Array.from({ length: rounds }, (_, i) => i + 1);
  const order = espnOrder(said);

  // every team is offered, since ESPN will not say which one is yours
  // unless you are signed in to it
  return teams.map((team) => ({
    provider: "espn" as const,
    leagueId: String(leagueId),
    season,
    name: (settings.name ?? "ESPN league").trim() + " (" + nameOf(team) + ")",
    size: teams.length,
    pays,
    slots,
    userId: String(team.id),
    team: nameOf(team),
    members: Object.fromEntries(teams.map((t) => [String(t.id), nameOf(t)])),
    myRoster: menOf(team),
    myPicks: everyRound,
    draftSlot: order[String(team.id)] ?? null,
    snake: true,
    allRosters: teams.map((t) => ({
      owner: nameOf(t), picks: everyRound, keys: menOf(t),
    })),
  }));
}

/**
 * An ESPN draft as it is right now.
 *
 * The whole board exists before anyone picks: every slot is listed with
 * a player id of -1 until somebody fills it. Those empty slots are
 * dropped here, so what comes back is the picks actually made, which is
 * what Sleeper gives too.
 *
 * A pick has only a number in it, so names come from the player list.
 * Where ESPN has already put a man on a roster it gives his name in
 * this same answer, and that wins, since it cannot be out of date.
 */
async function espnDraft(league: League): Promise<DraftNow | null> {
  const said = await espnAnswer(league.leagueId, league.season);
  const detail = said?.draftDetail;

  if (!detail?.picks) {
    return null;
  }

  const picks = detail.picks as EspnPick[];
  const men = await espnPlayers(league.season).catch(() => ({} as EspnMen));
  const named = new Map<number, { name: string; pos: string }>();

  for (const [id, man] of Object.entries(men)) {
    named.set(Number(id), { name: man.n, pos: man.p });
  }

  for (const team of (said.teams ?? []) as EspnTeam[]) {
    for (const entry of team.roster?.entries ?? []) {
      const man = entry.playerPoolEntry?.player;
      const id = man?.id ?? entry.playerId;

      if (id && man?.fullName) {
        const pos = ESPN_POSITIONS[man.defaultPositionId ?? -1] ?? "";
        named.set(id, { name: espnNameOf(id, man.fullName, pos), pos });
      }
    }
  }

  const teams = (said.teams ?? []).length || league.size;
  const order = espnOrder(said);

  return {
    draft: {
      settings: { teams, rounds: Math.max(...picks.map((p) => p.roundId), 1) },
      draft_order: order,
      status: detail.drafted
        ? "complete"
        : detail.inProgress ? "drafting" : "pre_draft",
    },
    picks: picks
      .filter((pick) => named.has(pick.playerId))
      .map((pick) => ({
        player_id: String(pick.playerId),
        picked_by: String(pick.teamId),
        pick_no: pick.overallPickNumber ||
          (pick.roundId - 1) * teams + pick.roundPickNumber,
        round: pick.roundId,
        // the slot is where the team picks from, not where the pick
        // falls in the round: those two run opposite ways every other
        // round of a snake, which would mirror half the board
        draft_slot: order[String(pick.teamId)] ?? pick.roundPickNumber,
        is_keeper: Boolean(pick.keeper ?? pick.reservedForKeeper),
        name: named.get(pick.playerId)!.name,
        position: named.get(pick.playerId)!.pos,
      })),
  };
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
    draftNow: espnDraft,
  },
};

export const providerOf = (league: { provider?: string } | null) =>
  PROVIDERS[league?.provider ?? "sleeper"]!;

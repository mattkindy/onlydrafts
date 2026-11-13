/**
 * Why a player's snaps went up.
 *
 * The update breaks a rise only at thirty points and in two of his last
 * three games, since a man filling in for a hurt starter often has a big
 * game and hands the job back. That is a guess from the size of the move
 * and how long it held. His club's roster says why outright. Of the
 * teammates at his position, the one who lost the snaps is gone for long
 * (a reserve list, released, traded), or out short term and still on the
 * roster, or back already, or nobody lost them at all.
 *
 * Only what was known at the end of the cut week is read: the rosters,
 * the injury reports and the snap counts of that week and before. A man
 * placed on injured reserve the Tuesday after is on the next week's
 * roster, which the cut has not seen.
 */

import { loadSnapCounts, loadWeeklyRosters } from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";
import { loadWeeklyInjuryStatus } from "../data/weeklyStatus.js";
import type {
  PlayedWeek, RiseCause, RiseReason,
} from "./inSeasonLevel.js";

/** one man on a club's roster in one week, as a rise is read off it */
export interface RoomWeek {
  playerId: string;
  teamId: string;
  /** QB, RB, WR or TE, or FB for a back the depth chart calls one */
  position: string;
  week: number;
  /** the roster file's code: ACT, INA, RES, CUT, DEV and the rest */
  status: string;
  /** the league's reason code beside it, where the file has one */
  statusCode?: string;
  /** his share of his side's offensive snaps, 0 where he did not play */
  snapShare: number;
  /** listed Out, Doubtful or Questionable on his club's report that week */
  listed: boolean;
}

export interface Rooms {
  byPlayer: Map<string, RoomWeek[]>;
  /** everyone on a club at a skill position, by `team|week` */
  byClubWeek: Map<string, RoomWeek[]>;
  /** the weeks each club has a roster for, earliest first */
  clubWeeks: Map<string, number[]>;
}

/** how the rise was read, finer than the reason, for the bench to split by */
export type RiseDetail =
  | "reserve list"
  | "released"
  | "traded"
  | "listed"
  | "short reserve"
  | "back"
  | "playing less"
  | "benched"
  | "nobody lost them";

export interface ReadRise extends RiseCause {
  detail: RiseDetail;
  /** the teammate who lost the snaps, where one did */
  teammate?: string;
}

const GROUPS: Record<string, string> = {
  QB: "QB", RB: "RB", HB: "RB", FB: "FB", WR: "WR", TE: "TE",
};

/**
 * The room a man's snaps come out of. The roster files a fullback as a
 * back and only its depth chart column says he is one, and his snaps do
 * not go to the tailback when he sits.
 */
export function positionGroup(raw: string, depth?: string): string | undefined {
  return depth === "FB" ? "FB" : GROUPS[raw];
}

/** games at the end of the window a rise is looked for over, as the break */
const WINDOW = 3;
/** a game counts as one he rose in at this far over his games before */
export const RISE_GAP = 0.2;
/**
 * The teammate who lost the snaps has to have lost this many of them,
 * or nobody at his position is missing and the depth chart moved.
 */
export const LOST_GAP = 0.15;
/** still on the club: dressed, or on the roster and not dressed */
const WITH_CLUB = new Set(["ACT", "INA"]);
/** a reserve list a man came back from inside a week or two: COVID */
const SHORT_RESERVE = new Set(["R59"]);
/** let go, or let go and kept on the practice squad */
const OFF_ROSTER = new Set(["CUT", "DEV"]);

export function roomsFrom(rows: RoomWeek[]): Rooms {
  const byPlayer = new Map<string, RoomWeek[]>();
  const byClubWeek = new Map<string, RoomWeek[]>();
  const weeks = new Map<string, Set<number>>();

  for (const row of rows) {
    const his = byPlayer.get(row.playerId) ?? [];
    his.push(row);
    byPlayer.set(row.playerId, his);

    const key = `${row.teamId}|${row.week}`;
    const room = byClubWeek.get(key) ?? [];
    room.push(row);
    byClubWeek.set(key, room);

    const club = weeks.get(row.teamId) ?? new Set();
    club.add(row.week);
    weeks.set(row.teamId, club);
  }

  for (const his of byPlayer.values()) {
    his.sort((a, b) => a.week - b.week);
  }

  return {
    byPlayer,
    byClubWeek,
    clubWeeks: new Map([...weeks].map(
      ([team, set]) => [team, [...set].sort((a, b) => a - b)])),
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
}

function shareAt(rooms: Rooms, club: string, playerId: string, week: number): number {
  return rooms.byClubWeek.get(`${club}|${week}`)
    ?.find((r) => r.playerId === playerId)?.snapShare ?? 0;
}

type Standing =
  | { gone: true; detail: "reserve list" | "released" | "traded" }
  | { gone: false; row: RoomWeek; shortReserve: boolean };

/**
 * Where the teammate stood on the last roster the cut has seen of his
 * club. Missing from it, or on it under anything but active or inactive,
 * he is gone; a COVID list stint is the one reserve list read as short.
 */
export function standingAt(
  rooms: Rooms, playerId: string, club: string, cut: number,
): Standing {
  const clubLast = (rooms.clubWeeks.get(club) ?? []).filter((w) => w <= cut).at(-1);
  const his = (rooms.byPlayer.get(playerId) ?? []).filter((r) => r.week <= cut);
  const lastWeek = his.at(-1)?.week;
  const atLast = his.filter((r) => r.week === lastWeek);
  const here = atLast.find((r) => r.teamId === club);

  if (clubLast === undefined || lastWeek === undefined || lastWeek < clubLast || !here) {
    return {
      gone: true,
      detail: atLast.some((r) => r.teamId !== club) ? "traded" : "released",
    };
  }

  if (WITH_CLUB.has(here.status)) {
    return { gone: false, row: here, shortReserve: false };
  }

  if (here.statusCode && SHORT_RESERVE.has(here.statusCode)) {
    return { gone: false, row: here, shortReserve: true };
  }

  return { gone: true, detail: OFF_ROSTER.has(here.status) ? "released" : "reserve list" };
}

function reasonOf(detail: RiseDetail): RiseReason {
  switch (detail) {
    case "reserve list":
    case "released":
    case "traded":
      return "promotion";
    case "listed":
    case "short reserve":
    case "back":
      return "fill-in";
    default:
      return "depth";
  }
}

/**
 * Why his snaps went up over his last three games, or nothing where they
 * did not go up in any of them, or he has three games or fewer, or the
 * rosters do not have him.
 *
 * The games he rose in are those of his last three at least twenty points
 * over his share before them, the same before the break reads. The
 * teammate at his position on his club who lost the most share between
 * his games before and the games he rose in is the man the snaps came
 * from, and where he lost under fifteen points nobody is missing.
 */
export function readRise(
  rooms: Rooms,
  playerId: string,
  weeks: PlayedWeek[],
  cut: number,
): ReadRise | undefined {
  const played = weeks.filter((w) => w.week <= cut);

  if (played.length <= WINDOW) {
    return undefined;
  }

  const before = played.slice(0, -WINDOW);
  const was = mean(before.map((w) => w.snapShare));
  const rose = played.slice(-WINDOW).filter((w) => w.snapShare - was >= RISE_GAP);

  if (rose.length === 0) {
    return undefined;
  }

  const fromWeek = rose[0]!.week;
  const lastRose = rose.at(-1)!.week;
  const at = (rooms.byPlayer.get(playerId) ?? [])
    .filter((r) => r.week <= lastRose).at(-1);

  if (!at) {
    return undefined;
  }

  const club = at.teamId;
  const teammates = new Set<string>();

  for (const w of [...before, ...rose]) {
    for (const r of rooms.byClubWeek.get(`${club}|${w.week}`) ?? []) {
      if (r.position === at.position && r.playerId !== playerId) {
        teammates.add(r.playerId);
      }
    }
  }

  let teammate: string | undefined;
  let lost = -Infinity;

  for (const id of teammates) {
    const his =
      mean(before.map((w) => shareAt(rooms, club, id, w.week))) -
      mean(rose.map((w) => shareAt(rooms, club, id, w.week)));

    if (his > lost) {
      lost = his;
      teammate = id;
    }
  }

  if (!teammate || lost < LOST_GAP) {
    return { reason: "depth", fromWeek, detail: "nobody lost them" };
  }

  const read = (detail: RiseDetail): ReadRise => ({
    reason: reasonOf(detail), fromWeek, detail, teammate,
  });

  const standing = standingAt(rooms, teammate, club, cut);

  if (standing.gone) {
    return read(standing.detail);
  }

  if (standing.shortReserve) {
    return read("short reserve");
  }

  const missed = rose.some((w) => shareAt(rooms, club, teammate, w.week) === 0);

  if (standing.row.snapShare > 0) {
    return read(missed ? "back" : "playing less");
  }

  const listed = (rooms.byPlayer.get(teammate) ?? []).some((r) =>
    r.teamId === club && r.week >= fromWeek && r.week <= cut && r.listed);

  return read(listed ? "listed" : "benched");
}

/** a season's rosters with each man's snaps and report beside them */
export async function readRooms(season: number): Promise<Rooms> {
  const [rosters, snaps, report] = await Promise.all([
    loadWeeklyRosters(season).catch(() => []),
    loadSnapCounts(season).catch(() => []),
    loadWeeklyInjuryStatus(season).catch(() => new Map()),
  ]);
  const share = new Map<string, number>();

  for (const snap of snaps) {
    // the release has written this both as a share and as a percentage
    const pct = snap.offensePct > 1.5 ? snap.offensePct / 100 : snap.offensePct;
    share.set(`${normalizeName(snap.playerName)}|${snap.teamId}|${snap.week}`, pct);
  }

  const rows: RoomWeek[] = [];

  for (const r of rosters) {
    const position = positionGroup(r.rawPosition, r.depthPosition);

    if (!position) {
      continue;
    }

    const listed = report.get(`${r.playerId}|${r.week}`);
    rows.push({
      playerId: r.playerId,
      teamId: r.teamId,
      position,
      week: r.week,
      status: r.status ?? "",
      ...(r.statusCode ? { statusCode: r.statusCode } : {}),
      snapShare: share.get(`${normalizeName(r.name)}|${r.teamId}|${r.week}`) ?? 0,
      listed: !!listed && (listed.out || listed.questionable),
    });
  }

  return roomsFrom(rows);
}

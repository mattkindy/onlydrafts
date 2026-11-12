/**
 * What is known about a skill player at one week of a season, and what
 * his next three seasons came to.
 *
 * The board values a player for what is left of this season. A keeper
 * or a dynasty league is buying the next few as well, and those are a
 * different question: a rookie taken third overall who is hurt in
 * November is worth more next year than his November says. These rows
 * are what `model/seasonsAhead.ts` fits that question on.
 *
 * Everything on a row is read from weeks before the cut, so a row built
 * at week ten of a season knows what a reader on that Tuesday knew. The
 * outcomes are read off whole seasons after it and are absent where the
 * season has not finished.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import { loadDraftPicks } from "../data/draftPicks.js";
import { loadPlayerStats, loadWeeklyRosters, RAW_DIR } from "../data/nflverse.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";

export const AHEAD_POSITIONS = ["QB", "RB", "WR", "TE"];

/** how many seasons past the one being read the rows look */
export const HORIZONS = 3;

/** a season's games, which went from sixteen to seventeen in 2021 */
export const gamesInSeason = (season: number): number =>
  season >= 2021 ? 17 : 16;

/** and its last regular season week, a bye later */
export const lastWeekOf = (season: number): number =>
  gamesInSeason(season) + 1;

/** everything on a season is put on seventeen games */
const TO_SEVENTEEN = (season: number) => 17 / gamesInSeason(season);

/** where a player was drafted, null for a player nobody drafted */
export interface Drafted {
  season: number;
  round: number;
  overall: number;
}

/** what the players file says about a man, whatever season it is */
export interface Person {
  name: string;
  position: string;
  birthDate?: string;
  /** the first season he was in the league */
  entry?: number;
  drafted: Drafted | null;
}

/**
 * His age on the first of September of a season, to one decimal, which
 * is what the board's age is read as. Absent without a birth date.
 */
export function ageOn(birthDate: string | undefined, season: number): number | undefined {
  if (!birthDate) {
    return undefined;
  }

  const years = (Date.parse(`${season}-09-01`) - Date.parse(birthDate))
    / (365.25 * 24 * 3600 * 1000);

  return Number.isFinite(years) && years > 15 && years < 50
    ? Math.round(years * 10) / 10
    : undefined;
}

const numberOf = (text: string | undefined): number | undefined => {
  const n = Number(text);

  return text === undefined || text === "" || text === "NA" || !Number.isFinite(n)
    ? undefined
    : n;
};

/**
 * Everyone the players file knows, with the draft filled in from the
 * draft picks file where the players file has none. That file names the
 * newest class before the league has handed out its ids and is matched
 * by name in `loadDraftPicks`, so a rookie keeps his pick either way.
 */
export async function loadPeople(): Promise<{
  people: Map<string, Person>;
  /** pro football reference id to gsis id, which the snap counts need */
  gsisOfPfr: Map<string, string>;
}> {
  const rows = parseCsv(await readFile(join(RAW_DIR, "players.csv"), "utf8"));
  const picks = await loadDraftPicks().catch(() => new Map());
  const people = new Map<string, Person>();
  const gsisOfPfr = new Map<string, string>();

  for (const row of rows) {
    const id = row["gsis_id"] ?? "";

    if (!id) {
      continue;
    }

    if (row["pfr_id"]) {
      gsisOfPfr.set(row["pfr_id"], id);
    }

    const year = numberOf(row["draft_year"]);
    const round = numberOf(row["draft_round"]);
    const overall = numberOf(row["draft_pick"]);
    const pick = picks.get(id);
    const drafted: Drafted | null =
      year !== undefined && round !== undefined && overall !== undefined
        ? { season: year, round, overall }
        : pick
          ? { season: pick.season, round: pick.round, overall: pick.pick }
          : null;

    people.set(id, {
      name: row["display_name"] ?? "",
      position: row["position"] ?? "",
      birthDate: row["birth_date"] || undefined,
      entry: numberOf(row["rookie_season"]) ?? drafted?.season,
      drafted,
    });
  }

  return { people, gsisOfPfr };
}

/** one week of a player's, reduced to what the rows read */
export interface Line {
  team: string;
  position: string;
  points: number;
  /**
   * The count his share is taken of: carries and targets for a back,
   * targets for a receiver or a tight end, throws for a quarterback.
   */
  work: number;
}

/** what a club handed out in one week, by the count each position is read on */
export interface ClubWork {
  backs: number;
  targets: number;
  throws: number;
}

export interface RosterSpot {
  team: string;
  status: string;
  position: string;
}

/** one season's files, read once and keyed for the cut */
export interface SeasonRead {
  season: number;
  lines: Map<string, Map<number, Line>>;
  /** `team|week` */
  clubWork: Map<string, ClubWork>;
  /** the weeks each club has a box score for */
  clubWeeks: Map<string, Set<number>>;
  /** his share of his club's offensive snaps, by week */
  snaps: Map<string, Map<number, number>>;
  roster: Map<string, Map<number, RosterSpot>>;
  /** the weeks the roster file covers each club, which skips its bye */
  rosterWeeks: Map<string, Set<number>>;
  /** the last week with a box score in it */
  lastPlayed: number;
}

/**
 * The box scores file every season under the club's present name and the
 * roster file under the name it had then, so Oakland and San Diego have
 * to be moved before the two can be matched.
 */
const MOVED: Record<string, string> = { OAK: "LV", SD: "LAC", STL: "LA" };

export const clubNow = (team: string): string => MOVED[team] ?? team;

const workOf = (position: string, carries: number, targets: number, throws: number) =>
  position === "QB" ? throws : position === "RB" ? carries + targets : targets;

export const shareOfClub = (position: string, club: ClubWork): number =>
  position === "QB" ? club.throws : position === "RB" ? club.backs : club.targets;

/**
 * Where a caller files a player when the files disagree with it. The
 * weekly stats file Travis Hunter at cornerback, so without this his
 * catches never reach a receiver's row, and the board files him at
 * receiver.
 */
export type FiledAt = Map<string, string>;

export async function readSeason(
  season: number,
  rules: ScoringRules,
  gsisOfPfr: Map<string, string>,
  people: Map<string, Person>,
  filedAt: FiledAt = new Map(),
): Promise<SeasonRead> {
  const read: SeasonRead = {
    season,
    lines: new Map(), clubWork: new Map(), clubWeeks: new Map(),
    snaps: new Map(), roster: new Map(), rosterWeeks: new Map(),
    lastPlayed: 0,
  };
  const last = lastWeekOf(season);

  for (const week of await loadPlayerStats(season).catch(() => [])) {
    if (week.week > last) {
      continue;
    }

    const position = filedAt.get(week.playerId) ??
      (week.position || people.get(week.playerId)?.position || "");
    const club = read.clubWork.get(`${week.teamId}|${week.week}`)
      ?? { backs: 0, targets: 0, throws: 0 };

    club.targets += week.targets;
    club.throws += week.passing.attempts;

    if (position === "RB") {
      club.backs += week.carries + week.targets;
    }

    read.clubWork.set(`${week.teamId}|${week.week}`, club);

    const weeks = read.clubWeeks.get(week.teamId) ?? new Set<number>();
    weeks.add(week.week);
    read.clubWeeks.set(week.teamId, weeks);
    read.lastPlayed = Math.max(read.lastPlayed, week.week);

    if (!AHEAD_POSITIONS.includes(position)) {
      continue;
    }

    const his = read.lines.get(week.playerId) ?? new Map<number, Line>();
    his.set(week.week, {
      team: week.teamId,
      position,
      points: fantasyPoints(week.statLine, rules),
      work: workOf(position, week.carries, week.targets, week.passing.attempts),
    });
    read.lines.set(week.playerId, his);
  }

  for (const row of await loadWeeklyRosters(season).catch(() => [])) {
    const position = filedAt.get(row.playerId) ?? row.rawPosition.toUpperCase();

    if (!AHEAD_POSITIONS.includes(position) || row.week > last) {
      continue;
    }

    const his = read.roster.get(row.playerId) ?? new Map<number, RosterSpot>();
    const team = clubNow(row.teamId);

    his.set(row.week, { team, status: row.status ?? "", position });
    read.roster.set(row.playerId, his);

    const covered = read.rosterWeeks.get(team) ?? new Set<number>();
    covered.add(row.week);
    read.rosterWeeks.set(team, covered);
  }

  const snapText = await readFile(
    join(RAW_DIR, `snap_counts_${season}.csv`), "utf8").catch(() => "");

  for (const row of snapText ? parseCsv(snapText) : []) {
    if (row["game_type"] !== "REG") {
      continue;
    }

    const id = gsisOfPfr.get(row["pfr_player_id"] ?? "");
    const pct = Number(row["offense_pct"]);
    const week = Number(row["week"]);

    if (!id || !Number.isFinite(pct) || !Number.isFinite(week)) {
      continue;
    }

    const his = read.snaps.get(id) ?? new Map<number, number>();
    his.set(week, pct > 1.5 ? pct / 100 : pct);
    read.snaps.set(id, his);
  }

  return read;
}

/** where a player stood with his club at the cut */
export type Standing = "active" | "reserve" | "practice" | "off";

/**
 * The roster file spells a dozen codes and they come down to four. A
 * reserve list is a player his club has stopped expecting this season,
 * which is the strongest thing the file says about next season too.
 */
export function standingOf(status: string | undefined): Standing {
  switch (status) {
    case "ACT":
    case "INA":
      return "active";
    case "RES":
    case "PUP":
    case "RSN":
    case "NWT":
    case "SUS":
      return "reserve";
    case "DEV":
    case "TRC":
    case "TRT":
      return "practice";
    default:
      return "off";
  }
}

/** what one of his seasons came to, put on seventeen games */
export interface SeasonOutcome {
  games: number;
  points: number;
}

/** one player at one cut, and what came after */
export interface AheadRow {
  playerId: string;
  name: string;
  season: number;
  /** the cut: every week before it may be read, and nothing from it on */
  week: number;
  position: string;
  team: string;
  age?: number;
  /** seasons since he came into the league, nought for a rookie */
  experience: number;
  drafted: Drafted | null;
  /** games his club has played before the cut */
  clubGames: number;
  /** his games and points before the cut */
  games: number;
  points: number;
  /** his mean share of the snaps over the games he has a count for */
  snapShare?: number;
  /** the last three of those against the ones before */
  snapTrend?: number;
  /** his mean share of his club's work at his position over his games */
  share?: number;
  shareTrend?: number;
  /** last season and the one before, on seventeen games */
  last?: SeasonOutcome & { share?: number; snapShare?: number };
  before?: SeasonOutcome;
  standing: Standing;
  /** the busiest teammate at his position, by his share of the club's games */
  roomTopShare: number;
  /** the earliest pick among teammates at his position in their first three seasons */
  roomYoungPick?: number;
  /** what each of the next seasons came to, absent where it has not finished */
  ahead: (SeasonOutcome | undefined)[];
}

const meanOf = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** the last three against the rest, nought until there are five to read */
export function trendOf(values: number[]): number {
  if (values.length < 5) {
    return 0;
  }

  return meanOf(values.slice(-3)) - meanOf(values.slice(0, -3));
}

/** his season over a stretch of weeks */
function seasonOf(read: SeasonRead, playerId: string, before: number) {
  const lines = [...(read.lines.get(playerId) ?? new Map<number, Line>())]
    .filter(([week]) => week < before)
    .sort((a, b) => a[0] - b[0]);
  const shares: number[] = [];
  const snaps: number[] = [];

  for (const [week, line] of lines) {
    const club = read.clubWork.get(`${line.team}|${week}`);
    const of = club ? shareOfClub(line.position, club) : 0;

    if (of > 0) {
      shares.push(line.work / of);
    }

    const snap = read.snaps.get(playerId)?.get(week);

    if (snap !== undefined && snap > 0) {
      snaps.push(snap);
    }
  }

  return {
    games: lines.length,
    points: lines.reduce((sum, [, line]) => sum + line.points, 0),
    team: lines.at(-1)?.[1].team,
    position: lines.at(-1)?.[1].position,
    shares,
    snaps,
  };
}

/** a whole season, put on seventeen games */
export function outcomeOf(read: SeasonRead | undefined, playerId: string): SeasonOutcome | undefined {
  if (!read) {
    return undefined;
  }

  const his = seasonOf(read, playerId, lastWeekOf(read.season) + 1);
  const scale = TO_SEVENTEEN(read.season);

  return { games: his.games * scale, points: his.points * scale };
}

/** whether a season has been played to its last week */
export const finished = (read: SeasonRead | undefined): boolean =>
  read !== undefined && read.lastPlayed >= lastWeekOf(read.season);

/**
 * Every skill player his club had at the cut, or who had played for one
 * before it, with what he had done and where he stood.
 */
export function rowsAt(
  season: number,
  week: number,
  reads: Map<number, SeasonRead>,
  people: Map<string, Person>,
): AheadRow[] {
  const read = reads.get(season);

  if (!read) {
    return [];
  }

  const ids = new Set<string>();

  for (const [id, weeks] of read.roster) {
    if ([...weeks.keys()].some((w) => w <= week)) {
      ids.add(id);
    }
  }

  for (const [id, lines] of read.lines) {
    if ([...lines.keys()].some((w) => w < week)) {
      ids.add(id);
    }
  }

  /**
   * Where the roster file last had him at or before the cut. A club on
   * its bye has no rows that week, and the file runs a week or so behind
   * the box scores, so it is his club's latest week that decides whether
   * he is still there, not the cut itself.
   */
  const spotOf = (id: string): { spot: RosterSpot; current: boolean } | undefined => {
    let best: [number, RosterSpot] | undefined;

    for (const [w, spot] of read.roster.get(id) ?? []) {
      if (w <= week && (!best || w > best[0])) {
        best = [w, spot];
      }
    }

    if (!best) {
      return undefined;
    }

    const clubLatest = Math.max(
      0, ...[...(read.rosterWeeks.get(best[1].team) ?? [])].filter((w) => w <= week));

    return { spot: best[1], current: best[0] >= clubLatest };
  };

  /** each player's share of his club's games so far, absences as nought */
  const clubShare = new Map<string, number>();
  const now = new Map<string, ReturnType<typeof seasonOf>>();

  for (const id of ids) {
    const his = seasonOf(read, id, week);
    now.set(id, his);

    const team = his.team;
    const position = his.position;

    if (!team || !position) {
      continue;
    }

    const clubGames = [...(read.clubWeeks.get(team) ?? [])].filter((w) => w < week);
    let theirs = 0;
    let mine = 0;

    for (const w of clubGames) {
      const club = read.clubWork.get(`${team}|${w}`);
      theirs += club ? shareOfClub(position, club) : 0;
      mine += read.lines.get(id)?.get(w)?.work ?? 0;
    }

    clubShare.set(id, theirs > 0 ? mine / theirs : 0);
  }

  const standingNow = (id: string): Standing => {
    const at = spotOf(id);

    return at?.current ? standingOf(at.spot.status) : "off";
  };

  // who is in each room at the cut, by the roster where it has him
  const rooms = new Map<string, string[]>();
  const placeOf = new Map<string, { team: string; position: string }>();

  for (const id of ids) {
    const spot = spotOf(id)?.spot;
    const his = now.get(id)!;
    const team = spot?.team ?? his.team;
    const position = his.position ?? spot?.position ?? people.get(id)?.position;

    if (!team || !position || !AHEAD_POSITIONS.includes(position)) {
      continue;
    }

    placeOf.set(id, { team, position });

    const standing = standingNow(id);

    if (standing === "active" || standing === "reserve") {
      const key = `${team}|${position}`;
      rooms.set(key, [...(rooms.get(key) ?? []), id]);
    }
  }

  const rows: AheadRow[] = [];
  const prevRead = reads.get(season - 1);
  const prev2Read = reads.get(season - 2);

  for (const id of ids) {
    const place = placeOf.get(id);

    if (!place) {
      continue;
    }

    const person = people.get(id);
    const his = now.get(id)!;
    const clubGames = [...(read.clubWeeks.get(place.team) ?? [])]
      .filter((w) => w < week).length;
    const entry = person?.entry ?? person?.drafted?.season;
    const lastSeason = prevRead ? seasonOf(prevRead, id, lastWeekOf(season - 1) + 1) : undefined;
    const roommates = (rooms.get(`${place.team}|${place.position}`) ?? [])
      .filter((other) => other !== id);
    const youngPicks = roommates
      .map((other) => people.get(other))
      .filter((other) => other?.drafted && other.entry !== undefined && season - other.entry <= 2)
      .map((other) => other!.drafted!.overall);

    rows.push({
      playerId: id,
      name: person?.name ?? "",
      season,
      week,
      position: place.position,
      team: place.team,
      age: ageOn(person?.birthDate, season),
      experience: entry === undefined ? 3 : Math.max(0, season - entry),
      drafted: person?.drafted ?? null,
      clubGames,
      games: his.games,
      points: his.points,
      snapShare: his.snaps.length ? meanOf(his.snaps) : undefined,
      snapTrend: his.snaps.length ? trendOf(his.snaps) : undefined,
      share: his.shares.length ? meanOf(his.shares) : undefined,
      shareTrend: his.shares.length ? trendOf(his.shares) : undefined,
      last: lastSeason && lastSeason.games > 0
        ? {
            games: lastSeason.games * TO_SEVENTEEN(season - 1),
            points: lastSeason.points * TO_SEVENTEEN(season - 1),
            share: lastSeason.shares.length ? meanOf(lastSeason.shares) : undefined,
            snapShare: lastSeason.snaps.length ? meanOf(lastSeason.snaps) : undefined,
          }
        : prevRead ? { games: 0, points: 0 } : undefined,
      before: outcomeOf(prev2Read, id),
      standing: standingNow(id),
      roomTopShare: Math.max(0, ...roommates.map((other) => clubShare.get(other) ?? 0)),
      roomYoungPick: youngPicks.length ? Math.min(...youngPicks) : undefined,
      ahead: Array.from({ length: HORIZONS }, (_, k) => {
        const later = reads.get(season + k + 1);

        return finished(later) ? outcomeOf(later, id) : undefined;
      }),
    });
  }

  return rows;
}

/** every season's files from `first` to `last`, read once */
export async function readSeasons(
  first: number, last: number, rules: ScoringRules, filedAt: FiledAt = new Map(),
): Promise<{ reads: Map<number, SeasonRead>; people: Map<string, Person> }> {
  const { people, gsisOfPfr } = await loadPeople();
  const reads = new Map<number, SeasonRead>();

  for (let season = first; season <= last; season++) {
    reads.set(season, await readSeason(season, rules, gsisOfPfr, people, filedAt));
  }

  return { reads, people };
}

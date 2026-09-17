/**
 * Who kicks for each club, and what he has kicked.
 *
 * A club uses one kicker, so the question a board or a slate has to
 * answer first is which one, and the answer changes for about a third of
 * the league every spring. Three things say it, in order: whoever has
 * kicked for the club already this season, whoever is on its roster
 * going into the season, and failing both whoever took the most kicks
 * for it last season.
 *
 * Asking only the last of those put Matt Prater on Buffalo and Brandon
 * McManus on Green Bay for 2026, neither of whom is on an NFL roster.
 */

import {
  loadKickerWeeks, loadWeeklyRosters, type KickerWeek,
} from "../data/nflverse.js";
import { alsoCounted, BANDS, type KickerHistory } from "./kickerFromWalk.js";

/** a player's kicking over however many games are being added up */
export interface KickerRecord {
  playerId: string;
  name: string;
  team: string;
  games: number;
  /** his counting totals, not per game */
  parts: Record<string, number>;
}

/** the status the roster file gives a player who is on the active squad */
const ACTIVE = "ACT";

/** what a kicker makes from an extra point, and how many settle him */
const LEAGUE_EXTRA_POINT = 0.958;
const EXTRA_POINTS_SETTLE = 25;

export const extraPointRateOf = (made: number, missed: number) => {
  const taken = made + missed;
  const trust = taken / (taken + EXTRA_POINTS_SETTLE);

  return trust * (taken > 0 ? made / taken : LEAGUE_EXTRA_POINT) +
    (1 - trust) * LEAGUE_EXTRA_POINT;
};

/** his accuracy, in the shape the walk and the week models read it */
export function historyOf(record: KickerRecord): KickerHistory {
  const at = (part: string) => record.parts[part] ?? 0;

  return {
    attempts: at("fgm") + at("fgmiss"),
    made: at("fgm"),
    byBand: BANDS.map((band) => ({
      attempts: at(`fgm_${band.name}`) + at(`fgmiss_${band.name}`),
      made: at(`fgm_${band.name}`),
    })),
    extraPointRate: extraPointRateOf(at("xpm"), at("xpmiss")),
  };
}

/** every category of his added up over the weeks given */
export function addUp(weeks: KickerWeek[]): Record<string, number> {
  const parts: Record<string, number> = {};

  for (const week of weeks) {
    for (const [part, n] of Object.entries(week.parts)) {
      parts[part] = (parts[part] ?? 0) + n;
    }
  }

  return alsoCounted(parts);
}

/** each kicker's season, added up from his weeks */
export function recordsFrom(weeks: KickerWeek[]): Map<string, KickerRecord> {
  const byPlayer = new Map<string, KickerWeek[]>();

  for (const week of weeks) {
    byPlayer.set(week.playerId, [...(byPlayer.get(week.playerId) ?? []), week]);
  }

  return new Map([...byPlayer].map(([playerId, his]) => {
    const last = his[his.length - 1]!;

    return [playerId, {
      playerId,
      name: last.name,
      team: last.teamId,
      games: his.length,
      parts: addUp(his),
    }];
  }));
}

/** how much kicking a season of his amounts to, for picking between two */
const volumeOf = (record: KickerRecord) =>
  (record.parts["fgm"] ?? 0) + (record.parts["fgmiss"] ?? 0) +
  (record.parts["xpm"] ?? 0);

export interface KickerJob {
  /** last season's record, which is what his rates are read from */
  record: KickerRecord;
  team: string;
  /** true once he has kicked for the club this season */
  confirmed: boolean;
}

interface JobsRead {
  /** last season's kicker weeks, for the rates */
  lastSeason: KickerWeek[];
  /** this season's, up to but not including the week being projected */
  soFar: KickerWeek[];
  /** the club each kicker is on now, from the roster file */
  onRoster: Map<string, string>;
}

/**
 * The club each kicker is on now, from whichever roster week is the
 * latest that has him on the active squad. A kicker nobody has signed
 * is absent, which is how a retired one stops holding a job.
 */
export async function kickerRosterSpots(
  season: number,
): Promise<Map<string, string>> {
  const rows = await loadWeeklyRosters(season).catch(() => []);
  const latest = new Map<string, { team: string; week: number }>();

  for (const row of rows) {
    if (row.rawPosition !== "K" || row.status !== ACTIVE) {
      continue;
    }

    const already = latest.get(row.playerId);

    if (!already || row.week > already.week) {
      latest.set(row.playerId, { team: row.teamId, week: row.week });
    }
  }

  return new Map([...latest].map(([id, his]) => [id, his.team]));
}

/**
 * One kicker a club, with last season's record behind him.
 *
 * A kicker with no record behind him is left out rather than given the
 * league's average: a rookie's first weeks are the club's kicks with
 * nothing known about who takes them, and the models downstream would
 * rather say nothing than make a number up.
 */
export function kickerJobs(read: JobsRead): Map<string, KickerJob> {
  const records = recordsFrom(read.lastSeason);
  const jobs = new Map<string, KickerJob>();

  for (const record of records.values()) {
    const team = read.onRoster.get(record.playerId);

    if (read.onRoster.size > 0 && !team) {
      continue;
    }

    const at = team ?? record.team;
    const holder = jobs.get(at);

    if (!holder || volumeOf(record) > volumeOf(holder.record)) {
      jobs.set(at, { record, team: at, confirmed: false });
    }
  }

  // whoever has actually kicked for the club this season has the job,
  // whatever the spring said
  const kickedFor = new Map<
    string, { playerId: string; name: string; week: number }
  >();

  for (const week of read.soFar) {
    const already = kickedFor.get(week.teamId);

    if (!already || week.week > already.week) {
      kickedFor.set(week.teamId, {
        playerId: week.playerId, name: week.name, week: week.week,
      });
    }
  }

  for (const [team, his] of kickedFor) {
    // a kicker with nothing behind him still has the job, and the models
    // downstream fall back to what an average kicker does
    jobs.set(team, {
      record: records.get(his.playerId) ?? {
        playerId: his.playerId,
        name: his.name,
        team,
        games: 0,
        parts: {},
      },
      team,
      confirmed: true,
    });
  }

  return jobs;
}

/** the jobs for a season, reading every file they come from */
export async function loadKickerJobs(
  season: number, throughWeek = 1,
): Promise<Map<string, KickerJob>> {
  return kickerJobs({
    lastSeason: await loadKickerWeeks(season - 1),
    soFar: (await loadKickerWeeks(season)).filter((w) => w.week < throughWeek),
    onRoster: await kickerRosterSpots(season),
  });
}

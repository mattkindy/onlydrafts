/**
 * Loads the football facts into a database once, so every script reads
 * the same ones.
 *
 * The grain here is a player in a week, not a snap. Snap-level work
 * runs to millions of tuples and belongs in typed arrays; what belongs
 * in rules is which snaps and which players a question is about, since
 * that is the part that kept drifting between scripts.
 */

import { Database, evaluate, type Rule } from "@suss/datalog";
import { loadGames, loadPlayerStats, loadWeeklyRosters } from "../data/nflverse.js";
import { loadCoaches } from "../data/coaches.js";
import { ABSENCE_RULES, ROOM_RULES } from "./football.js";

export { ABSENCE_RULES, ROOM_RULES };

/** the last week that counts toward a season; the rest is the playoffs */
export const LAST_COUNTING_WEEK = 18;

export interface FactBase {
  db: Database;
  seasons: number[];
}

/**
 * Datalog has no inequality, so equality is asserted and the rules
 * negate it. A rule saying "not the same name" against an empty
 * `sameName` matches every pair, which is silent and wrong.
 */
function assertNames(db: Database, names: Iterable<string>): void {
  for (const name of new Set(names)) {
    db.add("sameName", [name, name]);
  }
}

/**
 * Pass only the rules a question needs. Deriving all of them costs
 * minutes, most of it spent on relations the caller never reads:
 * `missed` alone is over a hundred thousand tuples and the corner
 * question does not look at it.
 */
export async function loadFacts(
  seasons: number[],
  rules: Rule[],
): Promise<FactBase> {
  const db = new Database();
  const names: string[] = [];

  for (const [key, person] of await loadCoaches()) {
    const [team, season, role] = key.split("|");

    if (seasons.includes(Number(season))) {
      db.add("coached", [team!, Number(season), role!, person]);
      names.push(person, team!);
    }
  }

  for (const game of await loadGames()) {
    if (!seasons.includes(game.season) || game.week > LAST_COUNTING_WEEK) {
      continue;
    }

    db.add("met", [game.season, game.week, game.homeTeamId, game.awayTeamId]);
    db.add("met", [game.season, game.week, game.awayTeamId, game.homeTeamId]);
  }

  for (const season of seasons) {
    for (let week = 1; week <= LAST_COUNTING_WEEK; week++) {
      db.add("countingWeek", [season, week]);

      if (week > 1) {
        db.add("previousWeek", [season, week - 1, week]);
      }
    }

    if (seasons.includes(season - 1)) {
      db.add("previousSeason", [season, season - 1]);
    }

    for (const row of await loadWeeklyRosters(season)) {
      if (row.week <= LAST_COUNTING_WEEK) {
        db.add("rostered", [row.playerId, row.teamId, season, row.week]);
        names.push(row.teamId);
      }
    }

    // per-player season totals, so a rule can rank a receiving room
    const targets = new Map<string, { team: string; targets: number; position: string }>();

    for (const row of await loadPlayerStats(season)) {
      if (row.week > LAST_COUNTING_WEEK) {
        continue;
      }

      db.add("played", [row.playerId, season, row.week]);
      db.add("position", [row.playerId, season, row.position]);
      const entry = targets.get(row.playerId) ??
        { team: row.teamId, targets: 0, position: row.position };
      entry.targets += row.targets;
      targets.set(row.playerId, entry);
    }

    // who led each room, as a fact rather than a sort inside a loop
    const byTeam = new Map<string, [string, number][]>();

    for (const [id, entry] of targets) {
      if (entry.position !== "WR") {
        continue;
      }

      byTeam.set(entry.team, [...(byTeam.get(entry.team) ?? []), [id, entry.targets]]);
    }

    for (const [team, room] of byTeam) {
      room.sort((a, b) => b[1] - a[1]);
      room.forEach(([id], rank) => {
        db.add("targetRank", [id, team, season, rank + 1]);
      });
    }
  }

  assertNames(db, names);
  evaluate(db, rules);
  return { db, seasons };
}

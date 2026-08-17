/**
 * Turns the aggregated play-by-play into the roles the simulation
 * draws from, in one place, so a caller cannot quietly build them a
 * different way. Two evals doing that is how the goal-line snap count
 * came to be halved in one of them and not the other.
 *
 * Rates are shrunk toward the league's, hard when a man has few touches
 * in a situation. A back with three goal-line carries and two scores
 * has not shown he converts two thirds of them.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import {
  ROLLS_UP_TO, SITUATIONS, zeroBySituation,
  type FineSituation, type Situation,
} from "../model/situations.js";
import type { SituationalRole } from "../model/situationalWeek.js";

/** what an average man does, for anything we have little evidence about */
const LEAGUE = {
  catchRate: 0.64,
  yardsPerCatch: 10.4,
  yardsPerCarry: 4.3,
  scoresPerCatch: { openField: 0.03, thirdAndShort: 0.04, thirdAndLong: 0.03, nearGoal: 0.16 },
  scoresPerCarry: { openField: 0.01, thirdAndShort: 0.05, thirdAndLong: 0.02, nearGoal: 0.13 },
};

/**
 * How many touches it takes before a man's own rate is believed over
 * the league's, fitted against how often the real weeks were big,
 * quiet, or ended in the end zone.
 *
 * The two numbers pull opposite ways. Shrinking his yards harder
 * brings the average and the 100 yard games into line, .25 taking
 * yardage from +6% to +2% and big games from +27% to +16%, but it
 * flattens his ordinary weeks and adds to the quiet ones. Shrinking
 * his scoring at all costs the men who genuinely finish, so it barely
 * shrinks.
 */
export const TRUST_AFTER = { usage: 25, scoring: 2 };

export interface FittedSeason {
  /** the roster of each team, ready to simulate */
  byTeam: Map<string, SituationalRole[]>;
  /** plays a game each offence gets in each situation */
  playsByTeam: Map<string, Record<Situation, number>>;
  teamOf: Map<string, string>;
}

const shrink = (own: number, count: number, league: number, trust: number) =>
  (own * count + league * trust) / (count + trust);

export async function fitRoles(
  season: number,
  positions: Map<string, string>,
  gamesPlayed: Map<string, number>,
  weeks = 17,
  trust?: { usage: number; scoring: number },
): Promise<FittedSeason> {
  const rows = parseCsv(
    await readFile(
      join(import.meta.dirname, "..", "..", "data", "curated", "situations.csv"),
      "utf8",
    ),
  ).filter((r) => Number(r["season"]) === season);

  interface Raw {
    team: string;
    targets: Record<Situation, number>;
    receptions: Record<Situation, number>;
    recYds: Record<Situation, number>;
    carries: Record<Situation, number>;
    rushYds: Record<Situation, number>;
    scores: Record<Situation, number>;
  }

  const players = new Map<string, Raw>();
  const seen = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const fine = (row["situation"] ?? "") as FineSituation;
    const to = ROLLS_UP_TO[fine];
    const id = row["player"] ?? "";
    const team = row["team"] ?? "";

    if (!to || !["RB", "WR", "TE"].includes(positions.get(id) ?? "")) {
      continue;
    }

    const raw = players.get(id) ?? {
      team,
      targets: zeroBySituation(), receptions: zeroBySituation(),
      recYds: zeroBySituation(), carries: zeroBySituation(),
      rushYds: zeroBySituation(), scores: zeroBySituation(),
    };
    raw.targets[to] += Number(row["targets"]);
    raw.receptions[to] += Number(row["receptions"]);
    raw.recYds[to] += Number(row["recYds"]);
    raw.carries[to] += Number(row["carries"]);
    raw.rushYds[to] += Number(row["rushYds"]);
    raw.scores[to] += Number(row["scores"]);
    players.set(id, raw);

    // teamPlays repeats on every player's row, so read it once per
    // fine situation and add the ones that roll up together
    const perTeam = seen.get(team) ?? new Map<string, number>();
    perTeam.set(fine, Number(row["teamPlays"]));
    seen.set(team, perTeam);
  }

  const playsByTeam = new Map<string, Record<Situation, number>>();

  for (const [team, perTeam] of seen) {
    const counts = zeroBySituation();

    for (const [fine, plays] of perTeam) {
      const to = ROLLS_UP_TO[fine as FineSituation];
      if (to) counts[to] += plays / weeks;
    }

    playsByTeam.set(team, counts);
  }

  const byTeam = new Map<string, SituationalRole[]>();
  const teamOf = new Map<string, string>();

  for (const [id, raw] of players) {
    const plays = playsByTeam.get(raw.team) ?? zeroBySituation();
    const role: SituationalRole = {
      playerId: id,
      position: positions.get(id)!,
      targetShare: zeroBySituation(),
      carryShare: zeroBySituation(),
      catchRate: zeroBySituation(),
      yardsPerCatch: zeroBySituation(),
      yardsPerCarry: zeroBySituation(),
      scoresPerCatch: zeroBySituation(),
      scoresPerCarry: zeroBySituation(),
      // Fitted against how often 100 yard games happen. Below .5 the
      // number stops moving, which says the upside the model still
      // has too much of comes from touch counts rather than from the
      // yards on any one of them.
      yardSwing: 0.35,
      availability: Math.min(1, (gamesPlayed.get(id) ?? 0) / weeks),
    };

    // His share is of the plays that happened while he was out there.
    // Dividing by the team's whole season instead made a man who
    // played ten games look like a part-timer twice over, once in the
    // share and again in his availability.
    const hisGames = Math.max(1, gamesPlayed.get(id) ?? weeks);

    for (const s of SITUATIONS) {
      const seasonPlays = Math.max(1, plays[s] * hisGames);
      role.targetShare[s] = raw.targets[s] / seasonPlays;
      role.carryShare[s] = raw.carries[s] / seasonPlays;
      const usage = trust?.usage ?? TRUST_AFTER.usage;
      const scoring = trust?.scoring ?? TRUST_AFTER.scoring;
      role.catchRate[s] = shrink(
        raw.receptions[s] / Math.max(1, raw.targets[s]), raw.targets[s],
        LEAGUE.catchRate, usage,
      );
      role.yardsPerCatch[s] = shrink(
        raw.recYds[s] / Math.max(1, raw.receptions[s]), raw.receptions[s],
        LEAGUE.yardsPerCatch, usage,
      );
      role.yardsPerCarry[s] = shrink(
        raw.rushYds[s] / Math.max(1, raw.carries[s]), raw.carries[s],
        LEAGUE.yardsPerCarry, usage,
      );

      // the file gives one score count, so split it the way he was used
      const touches = raw.receptions[s] + raw.carries[s];
      const throughAir = touches > 0 ? raw.receptions[s] / touches : 0;
      role.scoresPerCatch[s] = shrink(
        (raw.scores[s] * throughAir) / Math.max(1, raw.receptions[s]),
        raw.receptions[s], LEAGUE.scoresPerCatch[s], scoring,
      );
      role.scoresPerCarry[s] = shrink(
        (raw.scores[s] * (1 - throughAir)) / Math.max(1, raw.carries[s]),
        raw.carries[s], LEAGUE.scoresPerCarry[s], scoring,
      );
    }

    byTeam.set(raw.team, [...(byTeam.get(raw.team) ?? []), role]);
    teamOf.set(id, raw.team);
  }

  return { byTeam, playsByTeam, teamOf };
}

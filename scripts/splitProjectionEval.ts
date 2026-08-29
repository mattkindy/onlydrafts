/**
 * Do the August splits predict the shares a season really had?
 *
 * The split projection feeds the walk's every allocation, and until
 * now a change to it was validated by replaying whole seasons. The
 * projection is a per man number and so is the outcome, so this
 * scores it directly: projected carry and target shares against the
 * shares each man went on to take, walk forward, in seconds. Men
 * whose last season was cut short are scored apart, since that class
 * is where the definitions bite.
 *
 * Run: npx tsx scripts/splitProjectionEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import {
  experienceBefore, pastShares, projectSplitShares, SHARING_POSITIONS,
} from "../src/features/projectedShares.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { loadAdp } from "../src/data/adp.js";
import { fitAdpShare } from "../src/features/adpShare.js";
import { normalizeName } from "../src/data/names.js";

const SEASONS = (process.argv[2] ?? "2023,2024,2025").split(",").map(Number);

const raw = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
));
const teamPlays = new Map<string, number>();

for (const r of raw) {
  if (["run", "pass"].includes(r["playType"] ?? "")) {
    const key = `${r["season"]}|${r["offense"]}`;
    teamPlays.set(key, (teamPlays.get(key) ?? 0) + 1);
  }
}

for (const season of SEASONS) {
  const week1 = (await loadWeeklyRosters(season))
    .filter((row) => row.week === 1);
  const roster = week1
    .map((row) => ({
      playerId: row.playerId,
      position: row.rawPosition,
      team: row.teamId,
    }))
    .filter((man) => SHARING_POSITIONS.includes(man.position));
  const adp = await loadAdp(season, "ppr")
    .catch(() => new Map<string, { adp: number }>());
  const curve = await fitAdpShare(
    [season - 3, season - 2, season - 1],
    (s, team) => teamPlays.get(`${s}|${team}`) ?? 0,
  );
  const market = new Map<string, { carry: number; target: number }>();
  const priced = new Map<string, number>();

  for (const row of week1) {
    const at = adp.get(`${normalizeName(row.name)}|${row.rawPosition}`);
    const implied = at ? curve.impliedShare(row.rawPosition, at.adp) : undefined;

    if (at) {
      priced.set(row.playerId, at.adp);
    }

    if (implied) {
      market.set(row.playerId, implied);
    }
  }

  const split = projectSplitShares({
    market,
    priced,
    season,
    roster,
    past: await pastShares(
      [season - 3, season - 2, season - 1],
      (s, team) => teamPlays.get(`${s}|${team}`) ?? 1000,
    ),
    picks: await loadDraftPicks(),
    experience: await experienceBefore(season),
  });

  const actualTouches = new Map<string, number>();
  const actualGames = new Map<string, Set<number>>();
  const ranBy = new Map<string, number>();
  const teamOf = new Map<string, string>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18) {
      continue;
    }

    actualTouches.set(
      s.playerId,
      (actualTouches.get(s.playerId) ?? 0) + (s.carries ?? 0) + (s.targets ?? 0),
    );
    const weeks = actualGames.get(s.playerId) ?? new Set<number>();
    weeks.add(s.week);
    actualGames.set(s.playerId, weeks);
    teamOf.set(s.playerId, s.teamId);
  }

  for (const [key, plays] of teamPlays) {
    if (Number(key.split("|")[0]) === season) {
      ranBy.set(key.split("|")[1]!, plays);
    }
  }

  const gamesLast = new Map<string, number>();
  const gamesBefore = new Map<string, number>();

  for (const [back, into] of [[1, gamesLast], [2, gamesBefore]] as const) {
    const seen = new Map<string, Set<number>>();

    for (const s of await loadPlayerStats(season - back).catch(() => [])) {
      if (s.week <= 18) {
        const weeks = seen.get(s.playerId) ?? new Set<number>();
        weeks.add(s.week);
        seen.set(s.playerId, weeks);
      }
    }

    for (const [id, weeks] of seen) {
      into.set(id, weeks.size);
    }
  }

  const rows = roster
    .map((man) => {
      const said = split.get(man.playerId);
      const ran = ranBy.get(teamOf.get(man.playerId) ?? man.team) ?? 0;
      const was = ran > 0
        ? (actualTouches.get(man.playerId) ?? 0) / ran
        : null;
      const games = actualGames.get(man.playerId)?.size ?? 0;

      return said && was !== null
        ? {
            playerId: man.playerId,
            said: said.carries + said.targets,
            was,
            // his share of a game he played, the walk's question
            wasRole: games > 0 ? was * (17 / games) : 0,
            playedEnough: games >= 4,
            hurtLast: (gamesLast.get(man.playerId) ?? 0) <= 8 &&
              (gamesBefore.get(man.playerId) ?? 0) >= 12,
          }
        : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const score = (subset: typeof rows, label: string) => {
    if (subset.length < 10) {
      return;
    }

    const played = subset.filter((r) => r.playedEnough);
    // levels, not ranks: the walk weighs these against teammates, so
    // a star priced at half his role is invisible to a correlation
    const level = played.length
      ? played.reduce((a, r) => a + r.said, 0) /
        Math.max(0.001, played.reduce((a, r) => a + r.wasRole, 0))
      : 0;
    console.log(
      `  ${label.padEnd(28)} ${String(subset.length).padStart(4)} men  ` +
      `share ${spearman(subset.map((r) => r.said), subset.map((r) => r.was)).toFixed(3)}  ` +
      `role ${spearman(played.map((r) => r.said), played.map((r) => r.wasRole)).toFixed(3)}  ` +
      `level ${level.toFixed(2)}`,
    );
  };

  console.log(`${season}:`);
  score(rows, "everyone");
  score(rows.filter((r) => r.hurtLast), "hurt last year, whole before");
}

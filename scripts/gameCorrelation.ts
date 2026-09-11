/**
 * How much do two players in the same NFL game move together, week to
 * week, in half-PPR scoring?
 *
 * Every player's own season mean comes off first, so what is left is the
 * part of a week that beat or missed his own normal. Pairs are named by
 * role, roles come from season totals inside a team, and a game-week
 * counts only when both men played at least half their team's offensive
 * snaps, or, where no snap row names them, when both scored. The last
 * block says how much wider the variance of a two-man sum is than
 * independence has it, which is what the simulator gets wrong today.
 * Run: npx tsx scripts/gameCorrelation.ts [--seasons 2019-2025]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCsv } from "../src/data/csv.js";
import { normalizeName } from "../src/data/names.js";
import {
  canonicalTeam,
  loadGames,
  loadPlayerStats,
  loadSnapCounts,
  RAW_DIR,
  type GameRow,
  type PlayerWeekStats,
} from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const BOOTSTRAPS = 200;
const SNAP_FLOOR = 0.5;

/** Kicking is not in the shared scoring rules, so spell it out here. */
const KICKER_RULES = {
  fieldGoal: 3,
  longBonus: 1,
  extraPoint: 1,
};

/** What a team defence scores, on the settings most leagues run. */
const DEFENCE_RULES = {
  sack: 1,
  interception: 2,
  fumbleRecovery: 2,
  touchdown: 6,
  safety: 2,
  block: 2,
};

function pointsAllowedScore(allowed: number): number {
  if (allowed === 0) {
    return 10;
  }

  if (allowed <= 6) {
    return 7;
  }

  if (allowed <= 13) {
    return 4;
  }

  if (allowed <= 20) {
    return 1;
  }

  if (allowed <= 27) {
    return 0;
  }

  if (allowed <= 34) {
    return -1;
  }

  return -4;
}

interface Line {
  /** unique per player and per team unit */
  id: string;
  name: string;
  position: string;
  season: number;
  week: number;
  teamId: string;
  points: number;
  eligible: boolean;
}

function halfPprPoints(row: PlayerWeekStats): number {
  if (row.position === "K") {
    return (
      row.kicking.made * KICKER_RULES.fieldGoal +
      row.kicking.longMade * KICKER_RULES.longBonus +
      row.kicking.extraPoints * KICKER_RULES.extraPoint
    );
  }

  return fantasyPoints(row.statLine, presets.half);
}

async function readRaw(season: number): Promise<Record<string, string>[]> {
  const text = await readFile(
    join(RAW_DIR, `stats_player_week_${season}.csv`),
    "utf8",
  );
  return parseCsv(text);
}

/**
 * Team defence and special teams, summed out of the individual defensive
 * rows plus the points the other side scored. Defensive and return
 * touchdowns are the spiky part of the unit's week and the shared loader
 * does not carry them, so this reads the release directly.
 */
async function defenceLines(season: number, games: GameRow[]): Promise<Line[]> {
  const rows = await readRaw(season);
  const totals = new Map<string, Record<string, number>>();

  for (const row of rows) {
    if (row["season_type"] !== "REG") {
      continue;
    }

    const week = Number(row["week"]);
    const team = canonicalTeam(row["team"] ?? "");

    if (!team || !Number.isFinite(week)) {
      continue;
    }

    const key = `${week}|${team}`;
    const sums = totals.get(key) ?? {
      sacks: 0,
      interceptions: 0,
      fumbleRecoveries: 0,
      touchdowns: 0,
      safeties: 0,
      blocks: 0,
    };
    const n = (column: string) => Number(row[column] ?? 0) || 0;

    sums["sacks"] = (sums["sacks"] ?? 0) + n("def_sacks");
    sums["interceptions"] =
      (sums["interceptions"] ?? 0) + n("def_interceptions");
    sums["fumbleRecoveries"] =
      (sums["fumbleRecoveries"] ?? 0) + n("fumble_recovery_opp");
    sums["touchdowns"] =
      (sums["touchdowns"] ?? 0) + n("def_tds") + n("special_teams_tds");
    sums["safeties"] = (sums["safeties"] ?? 0) + n("def_safeties");
    sums["blocks"] =
      (sums["blocks"] ?? 0) +
      n("def_punt_blocks") +
      n("def_pat_blocks") +
      n("def_fg_blocks");
    totals.set(key, sums);
  }

  const allowed = new Map<string, number>();

  for (const game of games) {
    if (game.season !== season) {
      continue;
    }

    if (game.homeScore === undefined || game.awayScore === undefined) {
      continue;
    }

    allowed.set(`${game.week}|${canonicalTeam(game.homeTeamId)}`, game.awayScore);
    allowed.set(`${game.week}|${canonicalTeam(game.awayTeamId)}`, game.homeScore);
  }

  const lines: Line[] = [];

  for (const [key, sums] of totals) {
    const conceded = allowed.get(key);

    if (conceded === undefined) {
      continue;
    }

    const [weekText, team] = key.split("|");
    const points =
      (sums["sacks"] ?? 0) * DEFENCE_RULES.sack +
      (sums["interceptions"] ?? 0) * DEFENCE_RULES.interception +
      (sums["fumbleRecoveries"] ?? 0) * DEFENCE_RULES.fumbleRecovery +
      (sums["touchdowns"] ?? 0) * DEFENCE_RULES.touchdown +
      (sums["safeties"] ?? 0) * DEFENCE_RULES.safety +
      (sums["blocks"] ?? 0) * DEFENCE_RULES.block +
      pointsAllowedScore(conceded);

    lines.push({
      id: `DST|${team}`,
      name: `${team} DST`,
      position: "DST",
      season,
      week: Number(weekText),
      teamId: team ?? "",
      points,
      eligible: true,
    });
  }

  return lines;
}

type Role = "QB" | "WR1" | "WR2" | "TE1" | "RB1" | "K";

/**
 * Roles come from the whole season inside one team. Ranking week by week
 * instead would promote somebody else in exactly the weeks the usual WR1
 * was quiet, which hides the co-movement being measured.
 */
function assignRoles(rows: PlayerWeekStats[]): Map<string, Role> {
  const byTeam = new Map<string, PlayerWeekStats[]>();

  for (const row of rows) {
    const list = byTeam.get(row.teamId) ?? [];
    list.push(row);
    byTeam.set(row.teamId, list);
  }

  const roles = new Map<string, Role>();

  for (const list of byTeam.values()) {
    const volume = new Map<
      string,
      { position: string; targets: number; carries: number; attempts: number }
    >();

    for (const row of list) {
      const held = volume.get(row.playerId) ?? {
        position: row.position,
        targets: 0,
        carries: 0,
        attempts: 0,
      };
      held.targets += row.targets;
      held.carries += row.carries;
      held.attempts += row.passing.attempts;
      volume.set(row.playerId, held);
    }

    const ranked = (position: string, by: "targets" | "carries" | "attempts") =>
      [...volume.entries()]
        .filter(([, v]) => v.position === position)
        .sort((a, b) => b[1][by] - a[1][by])
        .map(([id]) => id);

    const receivers = ranked("WR", "targets");

    if (receivers[0]) {
      roles.set(receivers[0], "WR1");
    }

    if (receivers[1]) {
      roles.set(receivers[1], "WR2");
    }

    const ends = ranked("TE", "targets");

    if (ends[0]) {
      roles.set(ends[0], "TE1");
    }

    const backs = ranked("RB", "carries");

    if (backs[0]) {
      roles.set(backs[0], "RB1");
    }

    const passers = ranked("QB", "attempts");

    if (passers[0]) {
      roles.set(passers[0], "QB");
    }

    for (const [id, v] of volume) {
      if (v.position === "K") {
        roles.set(id, "K");
      }
    }
  }

  return roles;
}

interface Pairing {
  label: string;
  left: Role | "DST";
  right: Role | "DST";
  side: "own" | "opposing";
}

const PAIRINGS: Pairing[] = [
  { label: "QB with own WR1", left: "QB", right: "WR1", side: "own" },
  { label: "QB with own WR2", left: "QB", right: "WR2", side: "own" },
  { label: "QB with own TE1", left: "QB", right: "TE1", side: "own" },
  { label: "QB with own RB1", left: "QB", right: "RB1", side: "own" },
  { label: "RB1 with own WR1", left: "RB1", right: "WR1", side: "own" },
  { label: "WR1 with own WR2", left: "WR1", right: "WR2", side: "own" },
  { label: "K with own QB", left: "K", right: "QB", side: "own" },
  { label: "QB with opposing QB", left: "QB", right: "QB", side: "opposing" },
  { label: "QB with opposing WR1", left: "QB", right: "WR1", side: "opposing" },
  { label: "QB with opposing RB1", left: "QB", right: "RB1", side: "opposing" },
  {
    label: "RB1 with opposing RB1",
    left: "RB1",
    right: "RB1",
    side: "opposing",
  },
  { label: "QB with opposing DST", left: "QB", right: "DST", side: "opposing" },
  {
    label: "WR1 with opposing DST",
    left: "WR1",
    right: "DST",
    side: "opposing",
  },
  {
    label: "RB1 with opposing DST",
    left: "RB1",
    right: "DST",
    side: "opposing",
  },
];

interface Observation {
  x: number;
  y: number;
}

/** One game's observations, one list per pairing in the order above. */
interface GameBundle {
  pairs: Observation[][];
}

function pearson(observations: Observation[]): number {
  const n = observations.length;

  if (n < 3) {
    return Number.NaN;
  }

  let sx = 0;
  let sy = 0;

  for (const o of observations) {
    sx += o.x;
    sy += o.y;
  }

  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;

  for (const o of observations) {
    sxy += (o.x - mx) * (o.y - my);
    sxx += (o.x - mx) * (o.x - mx);
    syy += (o.y - my) * (o.y - my);
  }

  if (sxx <= 0 || syy <= 0) {
    return Number.NaN;
  }

  return sxy / Math.sqrt(sxx * syy);
}

function standardDeviations(observations: Observation[]): [number, number] {
  const n = observations.length;
  let sx = 0;
  let sy = 0;

  for (const o of observations) {
    sx += o.x;
    sy += o.y;
  }

  const mx = sx / n;
  const my = sy / n;
  let vx = 0;
  let vy = 0;

  for (const o of observations) {
    vx += (o.x - mx) * (o.x - mx);
    vy += (o.y - my) * (o.y - my);
  }

  return [Math.sqrt(vx / n), Math.sqrt(vy / n)];
}

function parseSeasons(argv: string[]): number[] {
  const flag = argv.indexOf("--seasons");

  if (flag < 0) {
    return [2019, 2020, 2021, 2022, 2023, 2024, 2025];
  }

  const [from, to] = (argv[flag + 1] ?? "").split("-").map(Number);
  const start = from ?? 2019;
  const end = to ?? start;
  const seasons: number[] = [];

  for (let season = start; season <= end; season += 1) {
    seasons.push(season);
  }

  return seasons;
}

async function linesForSeason(
  season: number,
  games: GameRow[],
): Promise<{ lines: Line[]; roles: Map<string, Role> }> {
  const rows = await loadPlayerStats(season);
  const snaps = await loadSnapCounts(season).catch(() => []);
  const snapShare = new Map<string, number>();

  for (const snap of snaps) {
    snapShare.set(
      `${snap.week}|${snap.teamId}|${normalizeName(snap.playerName)}`,
      snap.offensePct,
    );
  }

  const roles = assignRoles(rows);
  const lines: Line[] = rows.map((row) => {
    const points = halfPprPoints(row);
    const share = snapShare.get(
      `${row.week}|${row.teamId}|${normalizeName(row.playerName)}`,
    );

    return {
      id: row.playerId,
      name: row.playerName,
      position: row.position,
      season,
      week: row.week,
      teamId: row.teamId,
      points,
      // a kicker has a snap row and nought in its offensive column, so
      // the snap floor would rule out every kicker in the sample
      eligible:
        share === undefined || row.position === "K"
          ? points !== 0
          : share >= SNAP_FLOOR,
    };
  });

  lines.push(...(await defenceLines(season, games)));

  return { lines, roles };
}

/** Subtract each man's own season mean over the weeks he counted. */
function centre(lines: Line[]): Map<Line, number> {
  const sums = new Map<string, { total: number; count: number }>();

  for (const line of lines) {
    if (!line.eligible) {
      continue;
    }

    const key = `${line.season}|${line.id}`;
    const held = sums.get(key) ?? { total: 0, count: 0 };
    held.total += line.points;
    held.count += 1;
    sums.set(key, held);
  }

  const centred = new Map<Line, number>();

  for (const line of lines) {
    const held = sums.get(`${line.season}|${line.id}`);

    // a man with three counted weeks has a season mean that is mostly the
    // weeks themselves, and centring on it drives his leftovers to nought
    if (!line.eligible || !held || held.count < 4) {
      continue;
    }

    centred.set(line, line.points - held.total / held.count);
  }

  return centred;
}

async function main(): Promise<void> {
  const seasons = parseSeasons(process.argv.slice(2));
  const games = await loadGames();
  const opponentOf = new Map<string, string>();

  for (const game of games) {
    const home = canonicalTeam(game.homeTeamId);
    const away = canonicalTeam(game.awayTeamId);
    opponentOf.set(`${game.season}|${game.week}|${home}`, away);
    opponentOf.set(`${game.season}|${game.week}|${away}`, home);
  }

  const bundles: GameBundle[] = [];

  for (const season of seasons) {
    const { lines, roles } = await linesForSeason(season, games);
    const centred = centre(lines);
    const byTeamWeek = new Map<string, Map<Role | "DST", number>>();

    for (const [line, value] of centred) {
      const role = line.position === "DST" ? "DST" : roles.get(line.id);

      if (!role) {
        continue;
      }

      const key = `${line.week}|${line.teamId}`;
      const slot = byTeamWeek.get(key) ?? new Map<Role | "DST", number>();
      slot.set(role, value);
      byTeamWeek.set(key, slot);
    }

    const seen = new Set<string>();

    for (const key of byTeamWeek.keys()) {
      const [weekText, team] = key.split("|");
      const week = Number(weekText);
      const opponent = opponentOf.get(`${season}|${week}|${team}`);

      if (!opponent || !team) {
        continue;
      }

      const gameKey = `${week}|${[team, opponent].sort().join("@")}`;

      if (seen.has(gameKey)) {
        continue;
      }

      seen.add(gameKey);

      const orientations = [
        [team, opponent],
        [opponent, team],
      ];
      const pairs: Observation[][] = PAIRINGS.map(() => []);

      PAIRINGS.forEach((pairing, index) => {
        // the same two roles across the two sides is one observation, not
        // two, so a symmetric pairing reads one orientation only
        const symmetric =
          pairing.side === "opposing" && pairing.left === pairing.right;

        for (const [side, other] of symmetric
          ? orientations.slice(0, 1)
          : orientations) {
          const near = byTeamWeek.get(`${week}|${side}`);
          const far =
            pairing.side === "own" ? near : byTeamWeek.get(`${week}|${other}`);
          const x = near?.get(pairing.left);
          const y = far?.get(pairing.right);

          if (x === undefined || y === undefined) {
            continue;
          }

          pairs[index]?.push({ x, y });
        }
      });

      bundles.push({ pairs });
    }
  }

  const all: Observation[][] = PAIRINGS.map((_, index) =>
    bundles.flatMap((bundle) => bundle.pairs[index] ?? []),
  );
  const bootstrapped: number[][] = PAIRINGS.map(() => []);
  let state = 20240901;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  for (let round = 0; round < BOOTSTRAPS; round += 1) {
    const resampled: Observation[][] = PAIRINGS.map(() => []);

    for (let draw = 0; draw < bundles.length; draw += 1) {
      const bundle = bundles[Math.floor(random() * bundles.length)];

      if (!bundle) {
        continue;
      }

      PAIRINGS.forEach((_, index) => {
        const pairs = bundle.pairs[index];

        if (pairs) {
          resampled[index]?.push(...pairs);
        }
      });
    }

    PAIRINGS.forEach((_, index) => {
      const r = pearson(resampled[index] ?? []);

      if (Number.isFinite(r)) {
        bootstrapped[index]?.push(r);
      }
    });
  }

  console.log(
    `half-PPR, seasons ${seasons[0]} to ${seasons[seasons.length - 1]}, ` +
      `${bundles.length} games, ${BOOTSTRAPS} bootstrap resamples\n`,
  );
  console.log(
    "pair".padEnd(24) +
      "n".padStart(7) +
      "corr".padStart(8) +
      "95% interval".padStart(20),
  );

  const summary: { label: string; r: number; sd: [number, number] }[] = [];

  PAIRINGS.forEach((pairing, index) => {
    const observations = all[index] ?? [];
    const r = pearson(observations);
    const draws = [...(bootstrapped[index] ?? [])].sort((a, b) => a - b);
    const low = draws[Math.floor(draws.length * 0.025)];
    const high = draws[Math.floor(draws.length * 0.975)];
    const interval =
      low === undefined || high === undefined
        ? "n/a"
        : `${low.toFixed(3)} to ${high.toFixed(3)}`;

    console.log(
      pairing.label.padEnd(24) +
        String(observations.length).padStart(7) +
        (Number.isFinite(r) ? r.toFixed(3) : "n/a").padStart(8) +
        interval.padStart(20),
    );

    if (Number.isFinite(r) && observations.length > 50) {
      summary.push({
        label: pairing.label,
        r,
        sd: standardDeviations(observations),
      });
    }
  });

  const strongest = summary
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
    .slice(0, 3);

  console.log("\nvariance of the two-man sum, against independence\n");
  console.log("pair".padEnd(24) + "change".padStart(10));

  for (const entry of strongest) {
    const [sx, sy] = entry.sd;
    const independent = sx * sx + sy * sy;
    const change = ((2 * entry.r * sx * sy) / independent) * 100;
    console.log(
      entry.label.padEnd(24) +
        `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`.padStart(10),
    );
  }
}

main();

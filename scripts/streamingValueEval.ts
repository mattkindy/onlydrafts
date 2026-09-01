/**
 * What streaming a defence or a kicker is actually worth in a week.
 *
 * Replacement level for these two is the man you would pick up, and how
 * good he is depends on how much of his week you can see coming. So
 * this plays the three strategies over finished seasons: keep the best
 * one left, choose each week on the betting line, and choose with
 * hindsight. The first two are things a person can do. The third is the
 * ceiling, and the distance between them is what foresight buys.
 *
 * Run: npx tsx scripts/streamingValueEval.ts
 */

import { readFileSync } from "node:fs";

import { parseCsv } from "../src/data/csv.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

/** what the fallback scoring in the app pays a defence */
const DEF_PAYS: Record<string, number> = {
  sack: 1, int: 2, fum_rec: 2, def_td: 6, safe: 2, blk_kick: 2,
};

const bracketPay = (points: number) =>
  points < 1 ? 10 : points <= 6 ? 7 : points <= 13 ? 4 : points <= 20 ? 1
    : points <= 27 ? 0 : points <= 34 ? -1 : -4;

const num = (row: Record<string, string>, key: string) =>
  Number(row[key] ?? 0) || 0;

interface Week {
  season: number;
  week: number;
  team: string;
  points: number;
  /** points the betting line expected this defence to give up */
  expectedAgainst: number | null;
}

const games = parseCsv(readFileSync("data/raw/games.csv", "utf8"));

/**
 * What the line expected each defence to give up, which is the one
 * thing about next week a person can see before choosing.
 */
const expectedAgainst = new Map<string, number>();

for (const g of games) {
  const total = num(g, "total_line");
  const spread = num(g, "spread_line");

  if (!total) {
    continue;
  }

  const key = (team: string) => `${g["season"]}|${g["week"]}|${team}`;
  // the spread is written from the home side, so the home team is
  // expected to score the larger half when it is favoured. A defence
  // is measured by what the other side is expected to score.
  expectedAgainst.set(key(g["home_team"]!), total / 2 - spread / 2);
  expectedAgainst.set(key(g["away_team"]!), total / 2 + spread / 2);
}

const scored = new Map<string, number>();

for (const g of games) {
  const home = num(g, "home_score");
  const away = num(g, "away_score");

  if (!g["home_score"]) {
    continue;
  }

  scored.set(`${g["season"]}|${g["week"]}|${g["home_team"]}`, away);
  scored.set(`${g["season"]}|${g["week"]}|${g["away_team"]}`, home);
}

/** what a kicker's day is worth, by the same fallback the app uses */
const kickerPoints = (row: Record<string, string>) =>
  num(row, "fg_made_0_19") * 3 + num(row, "fg_made_20_29") * 3 +
  num(row, "fg_made_30_39") * 3 + num(row, "fg_made_40_49") * 4 +
  num(row, "fg_made_50_59") * 5 + num(row, "fg_made_60_") * 5 +
  num(row, "pat_made") -
  num(row, "fg_missed_0_19") * 3 - num(row, "fg_missed_20_29") * 2 -
  num(row, "fg_missed_30_39") * 2 - num(row, "fg_missed_40_49") -
  num(row, "fg_missed_50_59");

/**
 * A kicker's team is what the line prices, since his points come from
 * his own side moving the ball rather than from stopping anyone. So the
 * two positions read opposite halves of the same game.
 */
const expectedFor = new Map<string, number>();

for (const g of games) {
  const total = num(g, "total_line");
  const spread = num(g, "spread_line");

  if (!total) {
    continue;
  }

  const key = (team: string) => `${g["season"]}|${g["week"]}|${team}`;
  expectedFor.set(key(g["home_team"]!), total / 2 + spread / 2);
  expectedFor.set(key(g["away_team"]!), total / 2 - spread / 2);
}

const defenceWeeks: Week[] = [];
const kickerWeeks: Week[] = [];

for (const season of SEASONS) {
  const rows = parseCsv(
    readFileSync(`data/raw/stats_player_week_${season}.csv`, "utf8"),
  );
  const tally = new Map<string, Record<string, number>>();

  for (const row of rows) {
    const week = Number(row["week"]);

    if (!week || week > 18) {
      continue;
    }

    const at = `${season}|${week}|${row["team"]}`;

    if (row["position"] === "K") {
      const made = kickerPoints(row);

      if (num(row, "fg_att") || num(row, "pat_att")) {
        kickerWeeks.push({
          season, week, team: row["player_display_name"] ?? "", points: made,
          // a kicker wants his own side scoring, so the sign flips
          expectedAgainst: -(expectedFor.get(at) ?? 0),
        });
      }
    }

    const its = tally.get(at) ?? {};

    its["sack"] = (its["sack"] ?? 0) + num(row, "def_sacks");
    its["int"] = (its["int"] ?? 0) + num(row, "def_interceptions");
    its["fum_rec"] = (its["fum_rec"] ?? 0) + num(row, "def_fumbles");
    its["def_td"] = (its["def_td"] ?? 0) + num(row, "def_tds");
    its["safe"] = (its["safe"] ?? 0) + num(row, "def_safeties");
    its["blk_kick"] = (its["blk_kick"] ?? 0) +
      num(row, "def_punt_blocks") + num(row, "def_fg_blocks") +
      num(row, "def_pat_blocks");
    tally.set(at, its);
  }

  for (const [at, its] of tally) {
    const [, week, team] = at.split("|");
    const gave = scored.get(at);

    if (gave === undefined) {
      continue;
    }

    let points = bracketPay(gave);

    for (const [part, pay] of Object.entries(DEF_PAYS)) {
      points += (its[part] ?? 0) * pay;
    }

    defenceWeeks.push({
      season, week: Number(week), team: team!, points,
      expectedAgainst: expectedAgainst.get(at) ?? null,
    });
  }
}

const mean = (its: number[]) =>
  its.reduce((sum, n) => sum + n, 0) / Math.max(1, its.length);

/** the spread of the average, so a gap can be read against its own noise */
const errorOf = (its: number[]) => {
  const m = mean(its);
  const spread = its.reduce((sum, n) => sum + (n - m) ** 2, 0) /
    Math.max(1, its.length - 1);

  return Math.sqrt(spread / Math.max(1, its.length));
};

/**
 * Play the season out from the pool nobody rosters, one choice a week.
 * Ranking by how a man has gone so far is what a person actually knows,
 * so the pool is cut that way rather than by what he ended up doing.
 */
function playOut(weeks: Week[], kept: number) {
  const held: number[] = [];
  const byLine: number[] = [];
  const shared: number[][] = [];
  const bothWays: number[] = [];
  const hindsight: number[] = [];
  const everyone: number[] = [];

  for (const season of SEASONS) {
    const its = weeks.filter((w) => w.season === season);
    const upTo = new Map<string, { points: number; games: number }>();

    for (let week = 1; week <= 18; week++) {
      const here = its.filter((w) => w.week === week);
      const meanOf = (team: string) => {
        const so = upTo.get(team);

        return so && so.games > 0 ? so.points / so.games : 0;
      };

      // the first four weeks go by, since before them nobody has a
      // record to rank the pool on
      if (here.length && week > 4) {
        const ranked = [...here].sort((a, b) => meanOf(b.team) - meanOf(a.team));
        const pool = ranked.slice(kept);
        const drafted = ranked[0];

        /**
         * Holding a good one does not stop you streaming over him. In a
         * week the wire draws the softer offence you start the wire, so
         * what drafting him buys is only the weeks he is the better of
         * the two.
         */
        if (drafted?.expectedAgainst !== null && drafted) {
          const wire = pool
            .filter((w) => w.expectedAgainst !== null)
            .sort((a, b) => a.expectedAgainst! - b.expectedAgainst!)[0];

          bothWays.push(
            wire && wire.expectedAgainst! < drafted.expectedAgainst!
              ? wire.points
              : drafted.points,
          );
        }

        if (pool.length) {
          held.push(pool[0]!.points);
          hindsight.push(Math.max(...pool.map((w) => w.points)));
          everyone.push(mean(pool.map((w) => w.points)));

          const priced = pool
            .filter((w) => w.expectedAgainst !== null)
            .sort((a, b) => a.expectedAgainst! - b.expectedAgainst!);

          byLine.push((priced[0] ?? pool[0]!).points);

          /**
           * The pool in the order the room would claim it, so what a
           * team gets when others are streaming too can be read off it.
           * Only one of them takes the best matchup and the rest work
           * down the list.
           */
          if (priced.length) {
            shared.push(priced.map((w) => w.points));
          }
        }
      }

      for (const w of here) {
        const so = upTo.get(w.team) ?? { points: 0, games: 0 };
        so.points += w.points;
        so.games++;
        upTo.set(w.team, so);
      }
    }
  }

  return { held, byLine, shared, bothWays, hindsight, everyone };
}

/**
 * What a team gets when k of them stream off the same line. One takes
 * the best matchup and the others work down the list, so a team's
 * expected week is the average of the first k.
 */
const withRivals = (shared: number[][], k: number) =>
  mean(shared
    .filter((week) => week.length >= k)
    .map((week) => mean(week.slice(0, k))));

for (const [what, weeks, kept] of [
  ["defence", defenceWeeks, 12],
  ["kicker", kickerWeeks, 12],
] as [string, Week[], number][]) {
  const {
    held, byLine, shared, bothWays, hindsight, everyone,
  } = playOut(weeks, kept);

  console.log(
    `\n${what}: ${weeks.length} weeks over ${SEASONS.join(", ")},` +
    ` ${held.length} choices\n`,
  );
  console.log(`  taken at random from the pool    ${mean(everyone).toFixed(2)}`);
  console.log(
    `  keep the best one left           ${mean(held).toFixed(2)}` +
    ` (± ${errorOf(held).toFixed(2)})`,
  );
  console.log(
    `  stream, and nobody else does     ${mean(byLine).toFixed(2)}` +
    ` (± ${errorOf(byLine).toFixed(2)})`,
  );
  console.log(
    `  draft one and stream over him    ${mean(bothWays).toFixed(2)}` +
    ` (± ${errorOf(bothWays).toFixed(2)})`,
  );
  console.log(`  choose each week with hindsight  ${mean(hindsight).toFixed(2)}`);

  console.log("\n  what a streamer gets as the room crowds in:\n");

  for (const rivals of [1, 2, 3, 6, 9, 12]) {
    const got = withRivals(shared, rivals);

    console.log(
      `    ${String(rivals).padStart(2)} streaming   ${got.toFixed(2)}` +
      `   over holding ${(got - mean(held)).toFixed(2)}`,
    );
  }
}

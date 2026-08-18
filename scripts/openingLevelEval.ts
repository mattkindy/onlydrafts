/**
 * What a team is worth in August, from the men on it and from the room.
 *
 * The carried belief starts from nothing and loses to the betting total
 * for three weeks, .255 against .277, before beating it by nine
 * hundredths from week seven. The three weeks it loses are the ones the
 * roster already answers, so this asks whether the players say anything
 * the room has not already priced.
 *
 * Run: npx tsx scripts/openingLevelEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildPlayerVectors, poolVectors, ATTRIBUTES } from "../src/features/playerVector.js";

const RULES = presets.standard;
const SEASONS = [2022, 2023, 2024, 2025];
const EARLY = 3;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

const place = (values: number[]): number[] => {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const out = new Array<number>(values.length);
  order.forEach((o, at) => { out[o.i] = at + 1; });
  return out;
};

async function main(): Promise<void> {
  const rows: {
    season: number; week: number; team: string;
    scored: number; vegas: number; fromMen: number;
    described: Float64Array;
  }[] = [];

  for (const season of SEASONS) {
    // what the men on this year's roster made last year, wherever they
    // made it. Knowable in August and it moves when a roster does.
    const madeBefore = new Map<string, number>();

    for (const s of await loadPlayerStats(season - 1)) {
      if (s.week > 18) continue;
      madeBefore.set(
        s.playerId, (madeBefore.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
      );
    }

    const onRoster = new Map<string, Set<string>>();

    for (const s of await loadPlayerStats(season)) {
      if (s.week > EARLY || !["QB", "RB", "WR", "TE"].includes(s.position)) continue;
      const own = onRoster.get(s.teamId) ?? new Set<string>();
      own.add(s.playerId);
      onRoster.set(s.teamId, own);
    }

    const fromMen = new Map<string, number>();

    for (const [team, men] of onRoster) {
      fromMen.set(
        team,
        [...men].reduce((a, id) => a + (madeBefore.get(id) ?? 0), 0),
      );
    }

    // the same roster as a description, pooled from the men on it, which
    // is what the vectors were built for
    const vectors = await buildPlayerVectors(season - 1);
    const described = new Map<string, Float64Array>();

    for (const [team, men] of onRoster) {
      const known = [...men].map((id) => vectors.get(id))
        .filter((v): v is NonNullable<typeof v> => v !== undefined);
      described.set(
        team,
        known.length ? poolVectors(known) : new Float64Array(ATTRIBUTES.length),
      );
    }

    const scored = new Map<string, number>();

    for (const row of parseCsv(await readFile(
      join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
    ))) {
      if (Number(row["season"]) !== season || Number(row["week"]) > EARLY) continue;
      const key = `${row["week"]}|${row["offense"]}`;
      scored.set(key, (scored.get(key) ?? 0) + Number(row["points"]));
    }

    for (const game of await loadGames()) {
      if (game.season !== season || game.week > EARLY) continue;
      const total = game.totalLine;
      const line = game.spreadLine;
      if (total === undefined || line === undefined) continue;

      for (const [team, sign] of [
        [game.homeTeamId, 1], [game.awayTeamId, -1],
      ] as [string, number][]) {
        const points = scored.get(`${game.week}|${team}`);
        const men = fromMen.get(team);
        if (points === undefined || men === undefined) continue;
        rows.push({
          season, week: game.week, team, scored: points,
          vegas: total / 2 + (sign * line) / 2, fromMen: men,
          described: described.get(team) ?? new Float64Array(ATTRIBUTES.length),
        });
      }
    }
  }

  console.log(`${rows.length} team weeks in the first ${EARLY} of a season\n`);
  console.log("ranking what a side scores, more is better");

  const truth = rows.map((r) => r.scored);
  const vegasPlace = place(rows.map((r) => r.vegas));
  const menPlace = place(rows.map((r) => r.fromMen));

  /**
   * The roster as a description rather than as a sum. Fitted on the
   * seasons before each one, so no season helps guess itself.
   */
  const fromVectors = rows.map((row, i) => {
    const learnOn = rows.filter((r) => r.season < row.season);

    if (learnOn.length < 60) {
      return middle(truth);
    }

    const weights = fitRidge(
      learnOn.map((r) => [1, ...r.described]),
      learnOn.map((r) => r.scored),
      5,
    );
    void i;
    return predictRidge(weights, [1, ...row.described]);
  });
  const hasFit = rows.map((r, i) => ({ r, i }))
    .filter(({ r }) => r.season > SEASONS[0]!);

  console.log(
    "  the room                    " +
      spearman(rows.map((r) => r.vegas), truth).toFixed(4).padStart(7) +
      "\n  what the men made last year " +
      spearman(rows.map((r) => r.fromMen), truth).toFixed(4).padStart(7) +
      "\n  the roster, as a description" +
      spearman(
        hasFit.map(({ i }) => fromVectors[i]!),
        hasFit.map(({ r }) => r.scored),
      ).toFixed(4).padStart(7) +
      `   on ${hasFit.length} of them`,
  );

  const vectorPlace = place(fromVectors);
  console.log("\n  the room and the description mixed");

  for (const share of [0.1, 0.2, 0.3, 0.4]) {
    const mixed = hasFit.map(({ i }) =>
      -(share * vectorPlace[i]! + (1 - share) * vegasPlace[i]!));
    console.log(
      `    ${(100 * share).toFixed(0)}%`.padEnd(28) +
      spearman(mixed, hasFit.map(({ r }) => r.scored)).toFixed(4).padStart(7),
    );
  }

  console.log("\n  the two mixed, by how much of the men is used");

  for (const share of [0.1, 0.2, 0.3, 0.4, 0.5]) {
    const mixed = rows.map((_, i) =>
      -(share * menPlace[i]! + (1 - share) * vegasPlace[i]!));
    console.log(
      `    ${(100 * share).toFixed(0)}%`.padEnd(28) +
      spearman(mixed, truth).toFixed(4).padStart(7),
    );
  }

  console.log(`\n  give or take ${noise(rows.length).toFixed(3)}`);

  // and the same on how far off, since a rank says nothing about level
  const middleScored = middle(truth);
  const scaled = (values: number[]) => {
    const mid = middle(values);
    const spreadOf = (list: number[]) => {
      const m = middle(list);
      return Math.sqrt(middle(list.map((v) => (v - m) ** 2)));
    };
    const scale = spreadOf(truth) / Math.max(0.001, spreadOf(values));
    return values.map((v) => middleScored + (v - mid) * scale * 0.4);
  };

  console.log("\n  and how far off in points, less is better");
  console.log(
    "    the room                  " +
      rmse(rows.map((r) => r.vegas), truth).toFixed(2).padStart(6) +
      "\n    what the men made         " +
      rmse(scaled(rows.map((r) => r.fromMen)), truth).toFixed(2).padStart(6) +
      "\n    the same number always    " +
      rmse(rows.map(() => middleScored), truth).toFixed(2).padStart(6),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

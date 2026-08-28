/**
 * How far off we are on a particular team in a particular game.
 *
 * Everything so far has asked whether the model produces the right
 * spread of drives and games across a season, which is calibration and
 * comes cheap. This asks the harder thing: for this side on this
 * Sunday, how many points, how many yards, how many scores, and how
 * far off was the margin.
 *
 * Run: npx tsx scripts/boxScoreEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { fitSwings } from "../src/features/fitSwing.js";
import { fitEndings } from "../src/features/fitEndings.js";
import { loadDriveStarts, startFrom } from "../src/features/driveStarts.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import { fitFourthDown, type FourthRow } from "../src/features/fitFourthDown.js";
import { walkDrive } from "../src/model/driveFromFactors.js";
import { divideAmong } from "../src/features/shareCompetition.js";
import { buildMatchupTable } from "../src/features/matchupTable.js";
import { buildRunParts } from "../src/features/runParts.js";
import { buildDefenceOnField } from "../src/features/defenceOnField.js";
import { buildPlayLevel } from "../src/features/playLevel.js";
import { fitTargetDepth } from "../src/features/targetDepth.js";
import { fitPassing } from "../src/features/passerLevels.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import type { Call } from "../src/model/playFactors.js";

/** the fourth downs where a side actually chose, so not the flags */
const DECIDED = ["run", "pass", "field_goal", "punt"];

const SCORE_ON = 2025;
const LEARN = [2021, 2022, 2023, 2024];
const RUNS = Number(process.env["RUNS"] ?? 60);
const DRIVES = 11;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Truth {
  week: number;
  team: string;
  points: number;
  passYards: number;
  rushYards: number;
  scores: number;
  margin: number;
}

async function main(): Promise<void> {
  const touches = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const learnRows = touches.filter((r) => Number(r["season"]) < SCORE_ON)
    .map((r) => ({
      down: Number(r["down"]), toGo: Number(r["togo"]),
      yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
      secondsLeft: Number(r["seconds"]) || 1800,
      call: (r["playType"] ?? "") as Call,
      yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
      player: r["player"] ?? "", passer: r["passer"] ?? "",
      offence: r["offense"] ?? "", defence: r["defense"] ?? "",
      airYards: r["airYards"] === "" || r["airYards"] === undefined
        ? undefined : Number(r["airYards"]),
    })) as PlayRow[];

  const positions = new Map<string, string>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  const swings = await fitSwings(SCORE_ON - 1, positions);
  const { byTeam } = await fitRoles(SCORE_ON - 1, positions, played, 17, undefined, swings);
  const rules = await fitDriveRules(LEARN);
  const kicking = await fitEndings(LEARN);
  const starts = await loadDriveStarts([2022, 2023, 2024]);
  const picks = await loadDraftPicks();

  const fourths = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "fourths.csv"), "utf8",
  )).filter((r) =>
    Number(r["season"]) < SCORE_ON && Number(r["down"]) === 4 &&
    DECIDED.includes(r["playType"] ?? ""));
  const fourth = fitFourthDown(fourths.map((r) => ({
    toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
    choice: ["run", "pass"].includes(r["playType"] ?? "") ? "go"
      : r["playType"] === "field_goal" ? "kick" : "punt",
  })) as FourthRow[]);

  // each man's expected share, from the competition among his team
  const lastYear = new Map<string, number>();
  const teamPlays = new Map<string, number>();

  for (const r of touches.filter((x) => Number(x["season"]) === SCORE_ON - 1)) {
    const team = r["offense"] ?? "";
    teamPlays.set(team, (teamPlays.get(team) ?? 0) + 1);
    if (r["player"]) lastYear.set(r["player"]!, (lastYear.get(r["player"]!) ?? 0) + 1);
  }

  const projected = new Map<string, number>();
  const total: Record<string, number> = { RB: 0.31, WR: 0.33, TE: 0.11 };
  const asRookie: Record<string, number> = { RB: 0.09, WR: 0.06, TE: 0.03 };

  for (const [team, roster] of byTeam) {
    for (const spot of ["RB", "WR", "TE"]) {
      const group = roster.filter((p) => p.position === spot);
      if (!group.length) continue;
      const shares = divideAmong(
        group.map((p) => {
          const had = lastYear.get(p.playerId) ?? 0;
          return {
            playerId: p.playerId,
            standing: had > 0
              ? had / Math.max(1, teamPlays.get(team) ?? 1000)
              : picks.has(p.playerId) ? asRookie[spot]! : 0.005,
          };
        }),
        total[spot]!,
      );
      for (const [id, share] of shares) projected.set(id, share);
    }
  }

  // the network's read on a pairing, put where the team play counts
  // are, and left out when it is asked for
  const pairing = process.env["NO_MATCHUP"]
    ? undefined
    : await buildMatchupTable({ learn: LEARN.slice(-3), scoreOn: SCORE_ON });

  // a carry split into what the scheme opens and what the back makes
  const runParts = process.env["NO_PARTS"]
    ? undefined
    : await buildRunParts({ season: SCORE_ON });

  if (runParts) {
    console.log(
      `a carry is ${runParts.leagueBefore.toFixed(2)} yards before contact ` +
        `and ${runParts.leagueAfter.toFixed(2)} after, over ` +
        `${runParts.knownSides} sides who kept their coordinator ` +
        `and ${runParts.knownBacks} backs`,
    );
  }

  /**
   * The men on that defence this week, and the quarterback.
   *
   * The joint fit put the on-field defence at 1.3 yards a throw and
   * the quarterback at .53. Both go in as multipliers on a drawn
   * gain, which is the channel that cannot carry them, and both cost
   * the walk more than the pairing they replace. Off by default until
   * the draw itself can be moved.
   */
  const onField = process.env["PEOPLE"]
    ? await buildDefenceOnField({
        learn: [2022, 2023], describe: [2024, SCORE_ON],
      })
    : undefined;
  const passing = process.env["PEOPLE"] ? fitPassing(learnRows) : undefined;
  const middleYards = { run: 4.5, pass: 6.1 };

  if (onField && passing) {
    console.log(
      `the on-field fit knows ${onField.knownMen} men, ` +
        `and ${passing.knownPassers} men who threw it`,
    );
  }

  /**
   * Off by default, and worth understanding why. It knows more than
   * anything else here, and it says it through a multiplier on a
   * drawn gain, which cannot move how often a throw gains nothing.
   */
  const playLevel = process.env["LEVEL"]
    ? await buildPlayLevel({ learn: LEARN.slice(-3), scoreOn: SCORE_ON })
    : undefined;

  if (playLevel) {
    console.log(`the level model learned on ${playLevel.learnedOn} plays`);
  }

  /**
   * How far downfield each man is thrown, which picks his pool.
   *
   * Off by default. The measurements behind it are the strongest of
   * any taken here, but drawing from a depth pool costs the walk 1.8
   * points a game and nobody has found where that goes yet.
   */
  const depth = process.env["DEPTH"] ? fitTargetDepth(learnRows) : undefined;

  if (depth) {
    console.log(
      `depth known for ${depth.knownMen} men, the league throwing ` +
        depth.leagueBands.map((s) => `${(100 * s).toFixed(0)}%`).join(" / "),
    );
  }

  const factors = fitPlayFactors(learnRows, undefined, {
    projected, pairing: pairing?.bend, runParts, playLevel, depth,
    people: onField && passing
      ? {
          defenceNow: (defence, season, week, call) => {
            const effect = onField.weekOf(season, week, defence);

            if (effect === undefined) {
              return 1;
            }

            const moved = 1 - effect / middleYards[call];

            return Math.max(0.75, Math.min(1.25, moved));
          },
          passing: (receiver, passer) => passing.changeFor(receiver, passer),
        }
      : undefined,
  });

  // what really happened, per team per game
  const scored = new Map<string, Truth>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON || Number(row["week"]) > 18) continue;
    const key = `${row["week"]}|${row["offense"]}`;
    const own = scored.get(key) ?? {
      week: Number(row["week"]), team: row["offense"] ?? "",
      points: 0, passYards: 0, rushYards: 0, scores: 0, margin: 0,
    };
    own.points += Number(row["points"]);
    scored.set(key, own);
  }

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18) continue;
    const own = scored.get(`${s.week}|${s.teamId}`);
    if (!own) continue;
    own.passYards += s.statLine.recYds ?? 0;
    own.rushYards += s.statLine.rushYds ?? 0;
    own.scores += (s.statLine.recTd ?? 0) + (s.statLine.rushTd ?? 0);
  }

  const line = new Map<string, number>();

  for (const game of await loadGames()) {
    if (game.season !== SCORE_ON || game.week > 18) continue;
    const t = game.totalLine;
    const s = game.spreadLine;
    if (t === undefined || s === undefined) continue;
    line.set(`${game.week}|${game.homeTeamId}`, t / 2 + s / 2);
    line.set(`${game.week}|${game.awayTeamId}`, t / 2 - s / 2);
  }

  /**
   * Who they played and how many drives they got.
   *
   * Eleven for everybody is another constant: a side really gets
   * anywhere from eight to fifteen depending on the pace of the game,
   * and that alone moves its points by several.
   */
  const faced = new Map<string, string>();
  const driveCount = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON || Number(row["week"]) > 18) continue;
    const key = `${row["week"]}|${row["offense"]}`;
    faced.set(key, row["defense"] ?? "");
    driveCount.set(key, (driveCount.get(key) ?? 0) + 1);
  }

  // each side's main quarterback last season, since the walk now
  // wants to know who is throwing
  const attempts = new Map<string, Map<string, number>>();

  for (const r of touches.filter((x) => Number(x["season"]) === SCORE_ON - 1)) {
    if (r["playType"] !== "pass" || !r["passer"]) {
      continue;
    }

    const team = r["offense"] ?? "";
    const own = attempts.get(team) ?? new Map<string, number>();
    own.set(r["passer"]!, (own.get(r["passer"]!) ?? 0) + 1);
    attempts.set(team, own);
  }

  const throwsFor = new Map<string, string>();

  for (const [team, own] of attempts) {
    const most = [...own.entries()].sort((a, b) => b[1] - a[1])[0];
    if (most) throwsFor.set(team, most[0]);
  }

  const everyCount = [...driveCount.values()];
  const rng = seededRng(Number(process.env["SEED"] ?? 23));
  const rows: {
    truth: Truth; points: number; passYards: number; rushYards: number;
    scores: number; line: number;
  }[] = [];

  for (const [key, truth] of scored) {
    const roster = byTeam.get(truth.team);
    const priced = line.get(key);

    if (!roster || priced === undefined) {
      continue;
    }

    const among = roster.filter((p) => positions.has(p.playerId))
      .map((p) => p.playerId);
    let points = 0;
    let passYards = 0;
    let rushYards = 0;
    let scores = 0;

    const against = faced.get(key);

    for (let run = 0; run < RUNS; run++) {
      // drawn from what teams really get, rather than eleven every time
      const howMany = everyCount[Math.floor(rng() * everyCount.length)] ?? DRIVES;

      for (let i = 0; i < howMany; i++) {
        const drive = walkDrive(
          startFrom(starts, rng), factors,
          { ...rules, kickSucceeds: kicking.kickSucceeds }, fourth, among, rng,
          { isLast: kicking.isLast, lastLength: kicking.lastLength },
          {
            offence: truth.team, defence: against,
            passer: throwsFor.get(truth.team), season: SCORE_ON,
            week: truth.week,
          },
        );
        points += drive.ending === "touchdown" ? 7
          : drive.ending === "fieldGoal" ? 3 : 0;

        for (const play of drive.plays) {
          if (play.call === "run") rushYards += play.yards;
          else passYards += play.yards;
          if (play.scored) scores++;
        }
      }
    }

    rows.push({
      truth, points: points / RUNS, passYards: passYards / RUNS,
      rushYards: rushYards / RUNS, scores: scores / RUNS, line: priced,
    });
  }

  console.log(`${rows.length} team games in ${SCORE_ON}\n`);
  console.log("how far off, per team per game, in the thing's own units");
  console.log("  lower is better, and the ordering after it is better higher\n");
  console.log("  what                model   always the average   order");

  for (const [label, said, was] of [
    ["points", (r: (typeof rows)[number]) => r.points, (t: Truth) => t.points],
    ["passing yards", (r: (typeof rows)[number]) => r.passYards, (t: Truth) => t.passYards],
    ["rushing yards", (r: (typeof rows)[number]) => r.rushYards, (t: Truth) => t.rushYards],
    ["touchdowns", (r: (typeof rows)[number]) => r.scores, (t: Truth) => t.scores],
  ] as [string, (r: (typeof rows)[number]) => number, (t: Truth) => number][]) {
    const truth = rows.map((r) => was(r.truth));
    const guess = rows.map(said);
    const flat = rows.map(() => middle(truth));
    console.log(
      "  " + label.padEnd(20) + rmse(guess, truth).toFixed(2).padStart(6) +
      rmse(flat, truth).toFixed(2).padStart(21) +
      spearman(guess, truth).toFixed(3).padStart(9),
    );
  }

  const truth = rows.map((r) => r.truth.points);
  console.log(
    "  " + "points, the line".padEnd(20) +
    rmse(rows.map((r) => r.line), truth).toFixed(2).padStart(6) +
    "".padStart(21) + spearman(rows.map((r) => r.line), truth).toFixed(3).padStart(9),
  );

  console.log(
    `\n  the model says ${middle(rows.map((r) => r.points)).toFixed(1)} points, ` +
      `the line says ${middle(rows.map((r) => r.line)).toFixed(1)}, ` +
      `they scored ${middle(truth).toFixed(1)}`,
  );

  /**
   * How far apart the model puts two team games, against how far apart
   * they really are and how far the line puts them.
   *
   * Ordering nothing can mean two things: the model says everyone is
   * the same, or it says they differ and picks the wrong ones. This
   * tells them apart.
   */
  const spread = (values: number[]) => {
    const mid = middle(values);
    return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
  };

  console.log(
    "\n  how far apart it puts two team games, in points" +
      `\n    the model  ${spread(rows.map((r) => r.points)).toFixed(2)}` +
      `\n    the line   ${spread(rows.map((r) => r.line)).toFixed(2)}` +
      `\n    what happened ${spread(truth).toFixed(2)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

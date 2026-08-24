/**
 * Is there anything in where a man gets his work, beyond how much?
 *
 * A share model says his points are his touches times a rate. The
 * simulator gives him his work situation by situation, so a back who
 * gets the ball on the goal line scores more per touch than one who
 * does not. If that is worth nothing then the simulator cannot project
 * better than a share model, whatever else it is good for.
 *
 * Run: npx tsx scripts/situationValueEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { ROLLS_UP_TO, type FineSituation } from "../src/model/situations.js";

const RULES = presets.standard;
const SCORE_ON = Number(process.env["SEASON"] ?? 2025);

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Work {
  playerId: string;
  position: string;
  overall: number;
  /** the fine cuts, since the goal line is not the whole red zone */
  goalLine: number;
  insideTen: number;
  redZone: number;
  thirdDown: number;
  points: number;
}

/** what each man did, split by the situations the model draws for */
async function workOf(season: number): Promise<Map<string, Work>> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "situations.csv"), "utf8",
  )).filter((r) => Number(r["season"]) === season);
  const tally = new Map<string, Work>();

  for (const row of rows) {
    const playerId = row["player"] ?? "";

    if (!playerId) {
      continue;
    }

    const fine = (row["situation"] ?? "") as FineSituation;
    const coarse = ROLLS_UP_TO[fine];
    const touches = (Number(row["targets"]) || 0) + (Number(row["carries"]) || 0);
    const own = tally.get(playerId) ?? {
      playerId, position: "", overall: 0,
      goalLine: 0, insideTen: 0, redZone: 0, thirdDown: 0, points: 0,
    };
    own.overall += touches;
    if (fine === "goalLine") own.goalLine += touches;
    if (fine === "insideTen") own.insideTen += touches;
    if (fine === "redZone") own.redZone += touches;
    if (coarse === "thirdAndShort" || coarse === "thirdAndLong") own.thirdDown += touches;
    // what the work there was worth, from the file's own scores
    own.points += (Number(row["scores"]) || 0) * 6 +
      ((Number(row["recYds"]) || 0) + (Number(row["rushYds"]) || 0)) * 0.1;
    tally.set(playerId, own);
  }

  return tally;
}

async function main(): Promise<void> {
  const before = await workOf(SCORE_ON - 1);
  const now = await workOf(SCORE_ON);
  const scored = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    scored.set(
      s.playerId, (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const men = [...now.values()].filter((m) => scored.has(m.playerId) && m.overall >= 20);
  console.log(`${men.length} men in ${SCORE_ON} with twenty touches or more\n`);

  // first: given this season's work, does knowing where it came from
  // rank his points better than the count alone
  /**
   * What a touch is worth where he gets it. No weight is chosen here:
   * each is read off what those touches actually produced.
   */
  const worth = (of: (m: Work) => number) => {
    const touches = men.reduce((a, m) => a + of(m), 0);
    return touches < 200 ? 0 : touches;
  };
  void worth;

  const perTouch = men.map((m) => scored.get(m.playerId)! / m.overall);
  console.log("his points a touch, against where his work comes from");

  for (const [label, of] of [
    ["on the goal line", (m: Work) => m.goalLine],
    ["inside the ten", (m: Work) => m.insideTen],
    ["in the red zone at large", (m: Work) => m.redZone],
    ["on third down", (m: Work) => m.thirdDown],
  ] as [string, (m: Work) => number][]) {
    console.log(
      "  " + label.padEnd(30) +
      spearman(men.map((m) => of(m) / m.overall), perTouch).toFixed(4).padStart(7),
    );
  }

  // and split by whether he plays every down or is sent on for a job,
  // since a man used for one thing is all of that thing
  const heavy = men.filter((m) => m.overall >= 150);
  const light = men.filter((m) => m.overall < 150);
  console.log("\n  the same, on the goal line, split by how much he plays");

  for (const [label, set] of [
    ["men with 150 touches or more", heavy], ["men with fewer", light],
  ] as [string, Work[]][]) {
    if (set.length < 15) continue;
    console.log(
      "    " + label.padEnd(32) +
      spearman(
        set.map((m) => m.goalLine / m.overall),
        set.map((m) => scored.get(m.playerId)! / m.overall),
      ).toFixed(4).padStart(7) + `   (${set.length} men)`,
    );
  }

  // second, and the one that matters: is any of it forecastable
  const both = men.filter((m) => before.has(m.playerId));
  const was = (m: Work) => before.get(m.playerId)!;
  const truthBoth = both.map((m) => scored.get(m.playerId)!);
  console.log(
    `\nfrom last season, ranking this season's points, ${both.length} men   spearman`,
  );

  /**
   * The weight on third down work is fitted rather than picked, over
   * the season before, so nothing here is a number I chose.
   */
  const fitWeight = () => {
    let best = 0;
    let bestRank = -Infinity;

    for (let weight = 0; weight <= 6; weight += 0.25) {
      const rank = spearman(
        both.map((m) => was(m).overall + weight * was(m).thirdDown),
        both.map((m) => scored.get(m.playerId)!),
      );

      if (rank > bestRank) {
        bestRank = rank;
        best = weight;
      }
    }

    return best;
  };

  const weight = fitWeight();

  for (const [label, of] of [
    ["how much he got", (m: Work) => was(m).overall],
    [`with third down work at ${weight}x`, (m: Work) =>
      was(m).overall + weight * was(m).thirdDown],
    ["third down work alone", (m: Work) => was(m).thirdDown],
  ] as [string, (m: Work) => number][]) {
    console.log(
      "  " + label.padEnd(38) + spearman(both.map(of), truthBoth).toFixed(4).padStart(7),
    );
  }

  console.log(
    "\n  carried from one season to the next" +
      "\n    his third down work    " +
      spearman(
        both.map((m) => was(m).thirdDown), both.map((m) => m.thirdDown),
      ).toFixed(4) +
      "\n    his share of it        " +
      spearman(
        both.map((m) => was(m).thirdDown / Math.max(1, was(m).overall)),
        both.map((m) => m.thirdDown / Math.max(1, m.overall)),
      ).toFixed(4) +
      "\n    his points a touch     " +
      spearman(
        both.map((m) => was(m).points / Math.max(1, was(m).overall)),
        both.map((m) => scored.get(m.playerId)! / m.overall),
      ).toFixed(4),
  );
  /**
   * The question the simulator hangs on. Its contribution over a share
   * model is what a man does with a touch, and that turns out to carry
   * from one season to the next. So does using it beat giving everybody
   * the same rate, once the touches are a guess rather than known?
   */
  const leagueRate = middle(both.map((m) => was(m).points / Math.max(1, was(m).overall)));
  const ownRate = (m: Work, pull: number) => {
    const seen = was(m).overall;
    const his = was(m).points / Math.max(1, seen);
    // his own rate believed in proportion to how much he has shown
    return (his * seen + leagueRate * pull) / (seen + pull);
  };

  console.log("\nguessing this season's points, touches times a rate");
  console.log("  rate used                              spearman");
  console.log(
    "  the league's, the same for everyone   " +
      spearman(
        both.map((m) => was(m).overall * leagueRate), truthBoth,
      ).toFixed(4).padStart(7),
  );

  for (const pull of [0, 40, 100, 250]) {
    console.log(
      `  his own, pulled to the league by ${String(pull).padEnd(4)}` +
        spearman(
          both.map((m) => was(m).overall * ownRate(m, pull)), truthBoth,
        ).toFixed(4).padStart(9),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

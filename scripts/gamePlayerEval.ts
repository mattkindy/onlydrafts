/**
 * A player's season out of games played whole.
 *
 * Until now the player numbers came from an older loop: eleven drives
 * handed to each side, no clock, no opponent, no score, and every play
 * scored as a rush. This plays the 2025 schedule with the full game,
 * splits each man's share into his carries and his targets, and scores
 * the lines the games produce with the league's actual rules.
 *
 * Run: npx tsx scripts/gamePlayerEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { fitSwings } from "../src/features/fitSwing.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { fitEndings } from "../src/features/fitEndings.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import { fitFourthDown, climbTo, type FourthRow } from "../src/features/fitFourthDown.js";
import { fitPlayClock, timeBetween } from "../src/features/fitPlayClock.js";
import { fitTargetDepth } from "../src/features/targetDepth.js";
import {
  experienceBefore, pastShares, projectSplitShares, SHARING_POSITIONS,
} from "../src/features/projectedShares.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { playGame, linesFrom, type Side } from "../src/model/gameFromDrives.js";
import { myShare } from "../src/sim/acrossCores.js";
import type { Call } from "../src/model/playFactors.js";

/** the fourth downs where a side actually chose, so not the flags */
const DECIDED = ["run", "pass", "field_goal", "punt"];

const SCORE_ON = Number(process.env["SEASON"] ?? 2025);
const LEARN = [SCORE_ON - 4, SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1];
const RUNS = Number(process.env["RUNS"] ?? 20);
const RULES = presets.standard;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const raw = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const learnRows = timeBetween(
    raw.filter((r) => Number(r["season"]) < SCORE_ON).map((r) => ({
      season: Number(r["season"]), week: Number(r["week"]),
      offence: r["offense"] ?? "", defence: r["defense"] ?? "",
      down: Number(r["down"]), toGo: Number(r["togo"]),
      yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
      secondsLeft: Number(r["seconds"]) || 1800,
      call: (r["playType"] ?? "") as Call,
      yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
      player: r["player"] ?? "", passer: r["passer"] ?? "",
      airYards: r["airYards"] === "" || r["airYards"] === undefined
        ? undefined : Number(r["airYards"]),
      caught: r["caught"] === "" || r["caught"] === undefined
        ? undefined : r["caught"] === "1",
    })),
  );
  const ticking = fitPlayClock(learnRows);

  const positions = new Map<string, string>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  const swings = await fitSwings(SCORE_ON - 1, positions);
  const { byTeam } = await fitRoles(
    SCORE_ON - 1, positions, played, 17, undefined, swings,
  );
  const rules = await fitDriveRules(LEARN);
  const kicking = await fitEndings(LEARN);

  const fourths = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  )).filter((r) =>
    Number(r["season"]) < SCORE_ON && Number(r["down"]) === 4 &&
    DECIDED.includes(r["playType"] ?? ""));
  const fourthSeasons = [...new Set(fourths.map((r) => Number(r["season"])))];
  const fourth = fitFourthDown(
    fourths.map((r) => ({
      toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
      margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
      choice: ["run", "pass"].includes(r["playType"] ?? "") ? "go"
        : r["playType"] === "field_goal" ? "kick" : "punt",
    })) as FourthRow[],
    60, 6, 1, climbTo(fourthSeasons, SCORE_ON),
  );

  /**
   * Each man's carries and targets, won against the men who compete
   * for that half of the work rather than for all of it at once.
   */
  const teamPlays = new Map<string, number>();

  for (const r of raw) {
    if (["run", "pass"].includes(r["playType"] ?? "")) {
      const key = `${r["season"]}|${r["offense"]}`;
      teamPlays.set(key, (teamPlays.get(key) ?? 0) + 1);
    }
  }

  const roster = [...byTeam.entries()].flatMap(([team, men]) =>
    men
      .filter((p) => SHARING_POSITIONS.includes(p.position))
      .map((p) => ({ playerId: p.playerId, position: p.position, team })),
  );
  const split = projectSplitShares({
    season: SCORE_ON,
    roster,
    past: await pastShares(
      [SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1],
      (s, team) => teamPlays.get(`${s}|${team}`) ?? 1000,
    ),
    picks: await loadDraftPicks(),
    experience: await experienceBefore(SCORE_ON),
  });

  const depth = fitTargetDepth(learnRows);
  const factors = fitPlayFactors(learnRows as PlayRow[], undefined, {
    split, depth: process.env["NO_DEPTH"] ? undefined : depth,
  });

  // who throws for each side, from last season's attempts
  const attempts = new Map<string, Map<string, number>>();

  for (const r of raw.filter((x) => Number(x["season"]) === SCORE_ON - 1)) {
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

  /**
   * A quarterback runs too, and his share of the carries is his own
   * habit rather than a competition: nobody else scrambles for him.
   * Half of what the running quarterbacks score is on the ground, and
   * without this the walk projects them as statues.
   */
  const qbCarries = new Map<string, number>();
  const qbSeasons = [SCORE_ON - 2, SCORE_ON - 1];
  const carried = new Map<string, number>();

  for (const r of raw) {
    const season = Number(r["season"]);

    if (!qbSeasons.includes(season)) {
      continue;
    }

    if (r["playType"] === "run" && r["player"] &&
        positions.get(r["player"]!) === "QB") {
      carried.set(r["player"]!, (carried.get(r["player"]!) ?? 0) + 1);
    }

  }

  const everyQbCarry = [...carried.values()].reduce((a, b) => a + b, 0);
  const everyPlay = qbSeasons.reduce(
    (sum, season) =>
      sum + [...teamPlays.entries()]
        .filter(([key]) => key.startsWith(`${season}|`))
        .reduce((s2, [, n]) => s2 + n, 0),
    0,
  );
  const leagueQb = everyPlay > 0 ? everyQbCarry / everyPlay : 0.05;

  for (const [team] of attempts) {
    const passer = throwsFor.get(team);

    if (!passer) {
      continue;
    }

    const ran = carried.get(passer) ?? 0;
    const plays = qbSeasons.reduce(
      (sum, season) => sum + (teamPlays.get(`${season}|${team}`) ?? 0), 0,
    );

    if (plays <= 0) {
      qbCarries.set(passer, leagueQb);
      continue;
    }

    // his own habit, pulled toward the league until he has run enough
    const trust = ran / (ran + 30);
    qbCarries.set(passer, trust * (ran / plays) + (1 - trust) * leagueQb);
  }

  for (const [passer, share] of qbCarries) {
    split.set(passer, { carries: share, targets: 0 });
  }

  const sideFor = (team: string): Side | undefined => {
    const men = byTeam.get(team);

    if (!men) {
      return undefined;
    }

    const passer = throwsFor.get(team);

    return {
      team, factors, passer,
      among: [
        ...men
          .filter((p) => SHARING_POSITIONS.includes(p.position))
          .map((p) => p.playerId),
        ...(passer ? [passer] : []),
      ],
    };
  };

  // the schedule the season actually had
  const schedule = (await loadGames())
    .filter((g) => g.season === SCORE_ON && g.week <= 17);
  const mine = myShare(schedule);
  const rng = seededRng(Number(process.env["SEED"] ?? 23));
  const total = new Map<string, number>();
  const games = new Map<string, number>();

  for (const fixture of mine) {
    const home = sideFor(fixture.homeTeamId);
    const away = sideFor(fixture.awayTeamId);

    if (!home || !away) {
      continue;
    }

    const meanFor = new Map<string, number>();

    for (let run = 0; run < RUNS; run++) {
      const game = playGame(home, away, {
        rules: { ...rules, kickSucceeds: kicking.kickSucceeds },
        fourth,
        clock: { isLast: kicking.isLast, lastLength: kicking.lastLength },
        ticking, season: SCORE_ON, week: fixture.week,
      }, rng);

      for (const [playerId, line] of linesFrom(game, [home, away])) {
        meanFor.set(
          playerId,
          (meanFor.get(playerId) ?? 0) + fantasyPoints(line, RULES) / RUNS,
        );
      }
    }

    for (const [playerId, points] of meanFor) {
      total.set(playerId, (total.get(playerId) ?? 0) + points);
      games.set(playerId, (games.get(playerId) ?? 0) + 1);
    }
  }

  if (process.env["SHARES"]) {
    console.log(JSON.stringify([...total.entries()]));
    return;
  }

  // what they really scored, with the same rules
  const scored = new Map<string, number>();
  const names = new Map<string, string>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 17) {
      continue;
    }

    names.set(s.playerId, s.playerName);
    scored.set(
      s.playerId, (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const men = [...total.entries()]
    .filter(([playerId]) => scored.has(playerId) && (games.get(playerId) ?? 0) >= 10);
  const truth = men.map(([playerId]) => scored.get(playerId)! / 17);
  const guess = men.map(([, points]) => points / 17);

  console.log(`${men.length} men projected out of played games\n`);
  console.log(
    "  rank " + spearman(guess, truth).toFixed(4) +
      "   error " + rmse(guess, truth).toFixed(2) +
      "   says " + middle(guess).toFixed(2) +
      "   really " + middle(truth).toFixed(2),
  );

  // and against adp, on the men it priced
  const adp = await loadAdp(SCORE_ON, "ppr").catch(() => new Map());
  const priced = men
    .map(([playerId, points]) => ({
      points: points / 17,
      really: scored.get(playerId)! / 17,
      adp: adp.get(
        `${normalizeName(names.get(playerId) ?? "")}|${positions.get(playerId) ?? ""}`,
      )?.adp ?? null,
    }))
    .filter((row) => row.adp !== null);

  if (priced.length < 30) {
    console.log("\ntoo few men matched to adp");
    return;
  }

  const place = (values: number[]) => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const out = new Array<number>(values.length);
    order.forEach((row, rank) => { out[row.i] = rank + 1; });
    return out;
  };
  const pricedTruth = priced.map((row) => row.really);
  const byAdp = place(priced.map((row) => -row.adp!));
  const walked = place(priced.map((row) => row.points));

  console.log(`\nagainst adp, on the ${priced.length} men it priced\n`);
  console.log(
    "  where adp had him   " + spearman(byAdp.map((r) => -r), pricedTruth).toFixed(4),
  );
  console.log(
    "  the played games    " + spearman(walked.map((r) => -r), pricedTruth).toFixed(4),
  );

  for (const lean of [0.25, 0.38, 0.5]) {
    const mixed = walked.map((w, i) => -(lean * w + (1 - lean) * byAdp[i]!));
    console.log(
      `  mixed at ${(100 * lean).toFixed(0)}% walk    ` +
        spearman(mixed, pricedTruth).toFixed(4),
    );
  }

  /**
   * And inside bands of the draft, since an edge that lives only among
   * the men taken late is a different thing to sell than one across
   * the board. Ranks are rebuilt inside each band so early picks are
   * not being credited for beating late ones.
   */
  console.log("\ninside bands of the draft\n");
  console.log("  band            men   adp   the played games");

  for (const [label, from, upTo] of [
    ["the first 60", 0, 60], ["61 to 120", 60, 120], ["past 120", 120, 999],
  ] as [string, number, number][]) {
    const band = priced.filter((row) => row.adp! > from && row.adp! <= upTo);

    if (band.length < 20) {
      console.log("  " + label.padEnd(14) + String(band.length).padStart(4) +
        "   too few");
      continue;
    }

    const bandTruth = band.map((row) => row.really);
    const bandAdp = place(band.map((row) => -row.adp!));
    const bandWalk = place(band.map((row) => row.points));
    console.log(
      "  " + label.padEnd(14) + String(band.length).padStart(4) +
        spearman(bandAdp.map((r) => -r), bandTruth).toFixed(3).padStart(8) +
        spearman(bandWalk.map((r) => -r), bandTruth).toFixed(3).padStart(15),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

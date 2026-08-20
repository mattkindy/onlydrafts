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

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import {
  loadGames, loadPlayerStats, loadWeeklyRosters,
} from "../src/data/nflverse.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { fitEndings } from "../src/features/fitEndings.js";
import {
  fitPlayFactors, countPlays, storePlays, type PlayRow,
} from "../src/features/fitPlayFactors.js";
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
import { buildMatchupTable } from "../src/features/matchupTable.js";
import { countsFor } from "../src/features/countsCache.js";
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
  const positions = new Map<string, string>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  const total = new Map<string, number>();
  const games = new Map<string, number>();
  const onlyWeek = Number(process.env["WEEK"] ?? 0);
  const endings = new Map<string, number>();
  const boxSaid = new Map<string, {
    passYds: number; rushYds: number; receptions: number; recYds: number;
    tds: number;
  }>();
  let drivesSimmed = 0;
  const teamSaid = new Map<string, number>();

  /**
   * The scoring pass needs none of the fitting, so it skips all of
   * it. Running the full setup only to replace the totals with the
   * merged file cost a serial minute per season.
   */
  if (!process.env["MERGED"]) {
  const raw = parseCsv(await readFile( 
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const live = Boolean(process.env["LIVE"]) && onlyWeek > 1;
  const learnRows = timeBetween(
    raw.filter((r) =>
      Number(r["season"]) < SCORE_ON ||
      (live && Number(r["season"]) === SCORE_ON && Number(r["week"]) < onlyWeek),
    ).map((r) => ({
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


  /**
   * The cast comes from week one of the season being played, which a
   * drafter knows in August: who made the team, where the rookies
   * landed, who starts. Building it from last season's stats priced
   * every rookie at exactly nothing and handed Dallas to the backup
   * who mopped up while Prescott was hurt.
   */
  const castWeek = live ? onlyWeek : 1;
  const openingWeek = (await loadWeeklyRosters(SCORE_ON))
    .filter((row) => row.week === castWeek);
  const onTeam = new Map<string, { playerId: string; position: string }[]>();

  for (const row of openingWeek) {
    const position = positions.get(row.playerId) ?? row.rawPosition;

    if (!positions.has(row.playerId)) {
      positions.set(row.playerId, position);
    }

    onTeam.set(row.teamId, [
      ...(onTeam.get(row.teamId) ?? []), { playerId: row.playerId, position },
    ]);
  }

  const rules = await fitDriveRules(LEARN);
  const kicking = await fitEndings(LEARN);

  const fourths = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "fourths.csv"), "utf8",
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

  const roster = [...onTeam.entries()].flatMap(([team, men]) =>
    men
      .filter((p) => SHARING_POSITIONS.includes(p.position))
      .map((p) => ({ playerId: p.playerId, position: p.position, team })),
  );
  // deterministic per season, so it is worked out once and kept
  const splitAt = join(
    import.meta.dirname, "..", "data", "kept", `split-${SCORE_ON}.json`,
  );
  const splitKept = await readFile(splitAt, "utf8").catch(() => "");
  const split = splitKept
    ? new Map<string, { carries: number; targets: number }>(
        JSON.parse(splitKept) as [string, { carries: number; targets: number }][],
      )
    : projectSplitShares({
        season: SCORE_ON,
        roster,
        past: await pastShares(
          [SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1],
          (s, team) => teamPlays.get(`${s}|${team}`) ?? 1000,
        ),
        picks: await loadDraftPicks(),
        experience: await experienceBefore(SCORE_ON),
      });

  if (!splitKept && !live) {
    await writeFile(splitAt, JSON.stringify([...split.entries()]))
      .catch(() => undefined);
  }

  if (live) {
    /**
     * August's projection pulled toward what the season has shown.
     * Four weeks of evidence and the two count about equally, which
     * is where the season-to-date baseline started beating the frozen
     * walk on its own.
     */
    const soFar = new Map<string, { carries: number; targets: number }>();
    let teamWeeks = 0;
    const weeksSeen = new Set<number>();

    for (const r of raw) {
      if (Number(r["season"]) !== SCORE_ON || Number(r["week"]) >= onlyWeek) {
        continue;
      }

      weeksSeen.add(Number(r["week"]));

      if (!r["player"]) {
        continue;
      }

      const own = soFar.get(r["player"]!) ?? { carries: 0, targets: 0 };
      if (r["playType"] === "run") own.carries++;
      else own.targets++;
      soFar.set(r["player"]!, own);
    }

    teamWeeks = weeksSeen.size;
    let playsSoFar = 0;

    for (const r of raw) {
      if (
        Number(r["season"]) === SCORE_ON && Number(r["week"]) < onlyWeek &&
        ["run", "pass"].includes(r["playType"] ?? "")
      ) {
        playsSoFar++;
      }
    }

    const perWeekPlays = Math.max(30, playsSoFar / (32 * Math.max(1, teamWeeks)));
    const trust = teamWeeks / (teamWeeks + 4);

    for (const [playerId, shown] of soFar) {
      const august = split.get(playerId) ?? { carries: 0, targets: 0 };
      split.set(playerId, {
        carries: trust * (shown.carries / (teamWeeks * perWeekPlays)) +
          (1 - trust) * august.carries,
        targets: trust * (shown.targets / (teamWeeks * perWeekPlays)) +
          (1 - trust) * august.targets,
      });
    }
  }

  const depth = fitTargetDepth(learnRows);
  /**
   * The pairing is a table off the disk and it short-circuits the
   * per-side gathering, which was most of the time a play took.
   */
  const pairing = await buildMatchupTable({
    learn: [SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1].filter((s2) => s2 >= 2022),
    scoreOn: SCORE_ON,
  });
  const counted = live
    ? countPlays(learnRows as PlayRow[], undefined, false)
    : await countsFor(SCORE_ON, () => learnRows as PlayRow[]);
  const factors = fitPlayFactors([], undefined, {
    split, pairing: pairing.bend, counted,
    depth: process.env["NO_DEPTH"] ? undefined : depth,
    plays: process.env["NO_SAMPLE"]
      ? undefined : storePlays(learnRows as PlayRow[]),
  });

  /**
   * Who throws for each side: whoever took the throws in the opening
   * fortnight of the season being played. A drafter in August knows
   * the named starter; the first two weeks are the closest thing the
   * data has to that name, and they carry one fortnight of leak in a
   * seventeen week season.
   */
  const attempts = new Map<string, Map<string, number>>();

  const passerFrom = live ? Math.max(1, onlyWeek - 2) : 1;
  const passerTo = live ? onlyWeek - 1 : 2;

  for (const r of raw) {
    if (
      Number(r["season"]) !== SCORE_ON ||
      Number(r["week"]) < passerFrom || Number(r["week"]) > passerTo ||
      r["playType"] !== "pass" || !r["passer"]
    ) {
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
    const men = onTeam.get(team);

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

  /**
   * One week alone, when asked for. A season total buries how well
   * the players are known at the start under seventeen weeks of
   * drift the frozen descriptions never hear about, so week one is
   * the cleanest read on the knowing itself.
   */
  const schedule = (await loadGames())
    .filter((g) => g.season === SCORE_ON && g.week <= 17 &&
      (!onlyWeek || g.week === onlyWeek));
  const mine = myShare(schedule);
  const rng = seededRng(Number(process.env["SEED"] ?? 23));

  for (const fixture of
    process.env["MERGED"] || process.env["PREWARM"] ? [] : mine) {
    const home = sideFor(fixture.homeTeamId);
    const away = sideFor(fixture.awayTeamId);

    if (!home || !away) {
      continue;
    }

    const meanFor = new Map<string, number>();

    const saidPoints = new Map<string, number>();

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

        if (onlyWeek) {
          const box = boxSaid.get(playerId) ??
            { passYds: 0, rushYds: 0, receptions: 0, recYds: 0, tds: 0 };
          box.passYds += (line.passYds ?? 0) / RUNS;
          box.rushYds += (line.rushYds ?? 0) / RUNS;
          box.receptions += (line.receptions ?? 0) / RUNS;
          box.recYds += (line.recYds ?? 0) / RUNS;
          box.tds += ((line.rushTd ?? 0) + (line.recTd ?? 0) +
            (line.passTd ?? 0)) / RUNS;
          boxSaid.set(playerId, box);
        }
      }

      if (onlyWeek) {
        for (const one of game.possessions) {
          endings.set(
            one.drive.ending, (endings.get(one.drive.ending) ?? 0) + 1,
          );
          drivesSimmed++;
        }

        for (const team of [home.team, away.team]) {
          saidPoints.set(
            team, (saidPoints.get(team) ?? 0) + (game.points[team] ?? 0) / RUNS,
          );
        }
      }
    }

    for (const [team, points] of saidPoints) {
      teamSaid.set(`${fixture.week}|${team}`, points);
    }

    for (const [playerId, points] of meanFor) {
      total.set(playerId, (total.get(playerId) ?? 0) + points);
      games.set(playerId, (games.get(playerId) ?? 0) + 1);
    }
  }

  if (onlyWeek && !process.env["MERGED"]) {
    // the actual plays of this week, asked of the same factors
    const theWeek = raw.filter((r) =>
      Number(r["season"]) === SCORE_ON && Number(r["week"]) === onlyWeek &&
      ["run", "pass"].includes(r["playType"] ?? ""));
    let calls = 0;
    let rightCall = 0;
    let touches = 0;
    let covered = 0;
    let top1 = 0;

    for (const r of theWeek) {
      const state = {
        down: Number(r["down"]), toGo: Number(r["togo"]),
        yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
        secondsLeft: Number(r["seconds"]) || 1800,
      };

      if (!Number.isFinite(state.down) || !Number.isFinite(state.yardline)) {
        continue;
      }

      calls++;
      const pRun = factors.runs(state, r["offense"] ?? "");
      if ((pRun >= 0.5) === (r["playType"] === "run")) rightCall++;

      const who = r["player"] ?? "";
      const among = onTeam.get(r["offense"] ?? "")
        ?.filter((m) => SHARING_POSITIONS.includes(m.position))
        .map((m) => m.playerId);

      if (!who || !among?.length) {
        continue;
      }

      touches++;

      if (!among.includes(who)) {
        continue;
      }

      covered++;
      const shares = factors.goesTo(
        state, (r["playType"] ?? "") as Call, among,
      );
      const best = [...shares.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && best[0] === who) top1++;
    }

    console.log(
      "\nthe week itself, play by play: the call right " +
        (100 * rightCall / Math.max(1, calls)).toFixed(1) + "%, " +
        "the toucher first " +
        (100 * top1 / Math.max(1, covered)).toFixed(1) + "% " +
        "of " + covered + " covered, " + touches + " touched",
    );

    // how the simulated drives ended, against that week
    const drives = parseCsv(await readFile(
      join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
    )).filter((r) =>
      Number(r["season"]) === SCORE_ON && Number(r["week"]) === onlyWeek);
    const reallyEnded = new Map<string, number>();

    for (const r of drives) {
      const how = r["result"] === "Touchdown" ? "touchdown"
        : r["result"] === "Field goal" ? "fieldGoal"
        : r["result"] === "Punt" ? "punt" : "other";
      reallyEnded.set(how, (reallyEnded.get(how) ?? 0) + 1);
    }

    const pct = (n: number, of: number) =>
      (100 * n / Math.max(1, of)).toFixed(0) + "%";
    console.log(
      "per drive: touchdown " +
        pct(endings.get("touchdown") ?? 0, drivesSimmed) + " v " +
        pct(reallyEnded.get("touchdown") ?? 0, drives.length) +
        ", field goal " + pct(endings.get("fieldGoal") ?? 0, drivesSimmed) +
        " v " + pct(reallyEnded.get("fieldGoal") ?? 0, drives.length) +
        ", punt " + pct(endings.get("punt") ?? 0, drivesSimmed) +
        " v " + pct(reallyEnded.get("punt") ?? 0, drives.length),
    );

    // and the week's sixteen team games
    const teamReally = new Map<string, number>();

    for (const r of drives) {
      const key = r["week"] + "|" + r["offense"];
      teamReally.set(key, (teamReally.get(key) ?? 0) + Number(r["points"]));
    }

    const both = [...teamSaid.entries()]
      .filter(([key]) => teamReally.has(key));
    console.log(
      "per game: the week's team points ordered at " +
        spearman(
          both.map(([, p]) => p),
          both.map(([key]) => teamReally.get(key)!),
        ).toFixed(3) + " over " + both.length + " team games",
    );
  }

  if (onlyWeek && !process.env["MERGED"]) {
    // the box score itself, component by component against the week
    const boxReal = new Map<string, {
      passYds: number; rushYds: number; receptions: number; recYds: number;
      tds: number;
    }>();

    for (const s2 of await loadPlayerStats(SCORE_ON)) {
      if (s2.week !== onlyWeek) {
        continue;
      }

      boxReal.set(s2.playerId, {
        passYds: s2.statLine.passYds ?? 0,
        rushYds: s2.statLine.rushYds ?? 0,
        receptions: s2.statLine.receptions ?? 0,
        recYds: s2.statLine.recYds ?? 0,
        tds: (s2.statLine.rushTd ?? 0) + (s2.statLine.recTd ?? 0) +
          (s2.statLine.passTd ?? 0),
      });
    }

    const pieces: ["passYds" | "rushYds" | "receptions" | "recYds" | "tds",
      string, number][] = [
      ["passYds", "passing yards", 50],
      ["rushYds", "rushing yards", 15],
      ["receptions", "catches", 1],
      ["recYds", "receiving yards", 15],
      ["tds", "touchdowns", 0.1],
    ];

    console.log("the box score, over men either side put in it");

    for (const [key, label, atLeast] of pieces) {
      const pairs = [...boxSaid.entries()]
        .filter(([id, said]) =>
          said[key] >= atLeast || (boxReal.get(id)?.[key] ?? 0) >= atLeast)
        .map(([id, said]) => ({
          said: said[key], real: boxReal.get(id)?.[key] ?? 0,
        }));

      if (pairs.length < 15) {
        continue;
      }

      const mae = pairs.reduce((a, x) => a + Math.abs(x.said - x.real), 0) /
        pairs.length;
      console.log(
        "  " + label.padEnd(17) + String(pairs.length).padStart(4) + " men" +
          "   off by " + mae.toFixed(1) +
          "   ordered " + spearman(
            pairs.map((x) => x.said), pairs.map((x) => x.real),
          ).toFixed(3),
      );
    }
  }

  if (process.env["SHARES"]) {
    console.log(JSON.stringify({
      total: [...total.entries()], games: [...games.entries()],
    }));
    return;
  }

  } else {
    const merged = JSON.parse(
      await readFile(process.env["MERGED"], "utf8"),
    ) as { total: [string, number][]; games: [string, number][] };

    for (const [playerId, points] of merged.total) {
      total.set(playerId, points);
    }

    for (const [playerId, n] of merged.games) {
      games.set(playerId, n);
    }
  }

  /**
   * Expected games rather than seventeen for everybody.
   *
   * The walk plays every man healthy and its worst calls were bodies:
   * it had Tyreek Hill ninth and Lamar first in a season they missed.
   * Injury is mostly unforecastable, so this is base rates only: his
   * own games over the last two seasons, pulled toward the league.
   */
  const gamesBefore = new Map<string, number>();
  const seasonsSeen = new Map<string, Set<number>>();

  for (const season of [SCORE_ON - 2, SCORE_ON - 1]) {
    for (const s2 of await loadPlayerStats(season)) {
      if (s2.week <= 17) {
        gamesBefore.set(s2.playerId, (gamesBefore.get(s2.playerId) ?? 0) + 1);
        const own = seasonsSeen.get(s2.playerId) ?? new Set<number>();
        own.add(season);
        seasonsSeen.set(s2.playerId, own);
      }
    }
  }

  // what a man who mattered last season played of it, on average
  const before = new Map<string, { games: number; points: number }>();

  for (const s2 of await loadPlayerStats(SCORE_ON - 1)) {
    if (s2.week > 17) {
      continue;
    }

    const own = before.get(s2.playerId) ?? { games: 0, points: 0 };
    own.games++;
    own.points += fantasyPoints(s2.statLine, RULES);
    before.set(s2.playerId, own);
  }

  const mattered = [...before.values()].filter((o) => o.points >= 60);
  const leagueAvail = mattered.length
    ? mattered.reduce((a, o) => a + o.games, 0) / (17 * mattered.length)
    : 0.85;
  const availOf = (playerId: string) => {
    const seen = gamesBefore.get(playerId);
    const seasons = seasonsSeen.get(playerId)?.size ?? 0;

    if (seen === undefined || seasons === 0) {
      return leagueAvail;
    }

    // his games over the games he could have played, which is
    // seventeen for each season he was in the league, not a flat
    // thirty four that halves every one-season man
    const possible = 17 * seasons;
    const his = Math.min(1, seen / possible);
    const trust = possible / (possible + 17);

    return trust * his + (1 - trust) * leagueAvail;
  };

  for (const [playerId, points] of total) {
    total.set(playerId, onlyWeek ? points : points * availOf(playerId));
  }

  // what they really scored, with the same rules
  const scored = new Map<string, number>();
  const names = new Map<string, string>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 17 || (onlyWeek && s.week !== onlyWeek)) {
      continue;
    }

    names.set(s.playerId, s.playerName);
    scored.set(
      s.playerId, (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const spanned = onlyWeek ? 1 : 17;
  const men = [...total.entries()]
    .filter(([playerId]) =>
      scored.has(playerId) &&
      (games.get(playerId) ?? 0) >= (onlyWeek ? 1 : 10));
  const truth = men.map(([playerId]) => scored.get(playerId)! / spanned);
  const guess = men.map(([, points]) => points / spanned);

  const prevPpg = new Map<string, { points: number; games: number }>();

  for (const s2 of await loadPlayerStats(SCORE_ON - 1)) {
    if (s2.week > 17) {
      continue;
    }

    const own = prevPpg.get(s2.playerId) ?? { points: 0, games: 0 };
    own.points += fantasyPoints(s2.statLine, RULES);
    own.games++;
    prevPpg.set(s2.playerId, own);
  }

  const naive = men.map(([playerId]) => {
    const was = prevPpg.get(playerId);
    return was && was.games >= 4 ? was.points / was.games : 0;
  });

  /**
   * And what the season has already shown by this week, which is what
   * a live updater would know for free. Meaningless in week one.
   */
  const toDate = new Map<string, { points: number; games: number }>();

  if (onlyWeek > 1) {
    for (const s2 of await loadPlayerStats(SCORE_ON)) {
      if (s2.week >= onlyWeek || s2.week > 17) {
        continue;
      }

      const own = toDate.get(s2.playerId) ?? { points: 0, games: 0 };
      own.points += fantasyPoints(s2.statLine, RULES);
      own.games++;
      toDate.set(s2.playerId, own);
    }
  }

  console.log(`${men.length} men projected out of played games\n`);
  console.log(
    "  last season's points a game orders it " +
      spearman(naive, truth).toFixed(4),
  );

  if (onlyWeek > 1) {
    const shown = men.map(([playerId]) => {
      const so = toDate.get(playerId);
      return so && so.games >= 2 ? so.points / so.games : 0;
    });
    console.log(
      "  this season to date orders it         " +
        spearman(shown, truth).toFixed(4),
    );
  }

  console.log("");
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
      points: points / spanned,
      really: scored.get(playerId)! / spanned,
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

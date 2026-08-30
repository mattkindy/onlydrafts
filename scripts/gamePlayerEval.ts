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
import {
  fitPlayFactors, countPlays, storePlays, type PlayRow,
} from "../src/features/fitPlayFactors.js";
import { fitFourthDown, climbTo, type FourthRow } from "../src/features/fitFourthDown.js";
import { fitPlayClock, timeBetween } from "../src/features/fitPlayClock.js";
import { SHARING_POSITIONS } from "../src/features/projectedShares.js";
import { fitAbsence } from "../src/features/fitAbsence.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { sizeOf } from "../src/features/gameSize.js";
import { kickingVenue } from "../src/features/kickingVenue.js";
import { fitClimate, type Reading } from "../src/features/climate.js";
import { weatherLift } from "../src/features/weatherLift.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { playGame, linesFrom } from "../src/model/gameFromDrives.js";
import {
  gainedAt, gaveUpAt, reached, watchFourths, watchHowFar,
} from "../src/model/driveFromFactors.js";
import { myShare } from "../src/sim/acrossCores.js";
import { buildWorld } from "../src/features/playedWorld.js";
import type { Call } from "../src/model/playFactors.js";

/** the fourth downs where a side actually chose, so not the flags */

const SCORE_ON = Number(process.env["SEASON"] ?? 2025);
const RUNS = Number(process.env["RUNS"] ?? 20);
const RULES = presets.standard;

/**
 * The parts of a line every scoring system is built out of. Kept as
 * the names the stat line already uses, so applying a league's rules
 * to them is a lookup rather than a translation.
 *
 * The last four are how often he touched it rather than what he made
 * of it. No league pays for a carry, but the walk counts every one it
 * hands him, and a card that shows his yards from the walk and his
 * carries from somewhere else is showing two different players.
 */
const PARTS = [
  "passYds", "passTd", "interceptions", "rushYds", "rushTd",
  "receptions", "recYds", "recTd", "fumblesLost", "twoPointConversions",
  "carries", "targets", "passAtt", "passCmp",
] as const;

type StatTotals = Record<typeof PARTS[number], number>;

const blankTotals = (): StatTotals => ({
  passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0, fumblesLost: 0, twoPointConversions: 0,
  carries: 0, targets: 0, passAtt: 0, passCmp: 0,
});

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
  const samples = new Map<string, number[]>();
  /**
   * What each man actually did, before anybody scores it.
   *
   * A league that pays a point a catch orders receivers differently
   * from one that pays nothing, so the walk keeps the yards and the
   * catches and lets whoever reads the file apply their own rules.
   */
  const madeOf = new Map<string, StatTotals>();
  /**
   * What each side's kicker was handed: every attempt the drives
   * produced, by distance, and a conversion for every touchdown. A
   * kicker's season is his own accuracy over these, and this is where
   * the situation enters, since a drive that stalls on the twenty
   * from behind late is a kick and one that scores is a conversion.
   */
  const kicksFor = new Map<string, { from: number[]; conversions: number }>();
  /**
   * What the walk produces, for holding against what sides really get.
   * Printed when DRIVE_CHECK is set, since eight shares would say it
   * eight times otherwise.
   *
   * The kicking excess starts here. A fifth of the walk's throws go to
   * men it has fewer than 25 plays for, where the back of the roster
   * really takes a twentieth, and the pooled draw those fall back to
   * gains 4.62 against a targeted throw's 7.33. See the README beside
   * this for the rest of the chain.
   */
  const fourthsAt = new Map<string, { n: number; kick: number; punt: number; go: number }>();

  if (process.env["REACH_CHECK"]) {
    watchHowFar();
  }

  if (process.env["DRIVE_CHECK"]) {
    const band = (y: number) =>
      y <= 20 ? "inside 20" : y <= 30 ? "21-30" : y <= 40 ? "31-40"
        : y <= 50 ? "41-50" : "past 50";
    watchFourths((yardline: number, choice: string) => {
      const b = band(yardline);
      const seen = fourthsAt.get(b) ?? { n: 0, kick: 0, punt: 0, go: 0 };
      seen.n++;
      if (choice === "kick") seen.kick++;
      else if (choice === "punt") seen.punt++;
      else seen.go++;
      fourthsAt.set(b, seen);
    });
  }

  const droveHere = {
    drives: 0, plays: 0, seconds: 0, teamGames: 0, startedAt: 0, quick: 0,
    gained: 0, calls: 0, runYards: 0, runs: 0, passYards: 0, passes: 0,
    spread: new Map<number, number>(),
    faced: [] as number[],
    ends: new Map<string, number>(),
  };
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
  const live = Boolean(process.env["LIVE"]) && onlyWeek > 1;
  const {
    sideFor, rules, kicking, fourth, ticking, onTeam, factors, raw,
  } = await buildWorld(SCORE_ON, onlyWeek, live, positions);


  /**
   * One week alone, when asked for. A season total buries how well
   * the players are known at the start under seventeen weeks of
   * drift the frozen descriptions never hear about, so week one is
   * the cleanest read on the knowing itself.
   */
  // a season runs to week 18 and a side plays seventeen of them, so
  // stopping at seventeen gave everybody a game less than they get
  const schedule = (await loadGames())
    .filter((g) => g.season === SCORE_ON && g.week <= 18 &&
      (!onlyWeek || g.week === onlyWeek));
  const mine = myShare(schedule);
  /**
   * How many fixtures a side actually gets, which is the weeks in the
   * schedule less its bye. Counting the weeks instead overstates it by
   * one and every kicker ends up a kick short.
   */
  const gamesEachSideGets = (fixtures: typeof schedule) => {
    const each = new Map<string, number>();

    for (const g of fixtures) {
      each.set(g.homeTeamId, (each.get(g.homeTeamId) ?? 0) + 1);
      each.set(g.awayTeamId, (each.get(g.awayTeamId) ?? 0) + 1);
    }

    const counted = [...each.values()].sort((a, b) => a - b);

    return counted[Math.floor(counted.length / 2)] ?? 17;
  };
  const rng = seededRng(Number(process.env["SEED"] ?? 23));

  /**
   * Whether a man is up or down each week of one pass through the
   * season. Seeded by the man and the pass alone, so every share of
   * the job answers a week the same way, and one pass's absences
   * arrive in spells the way a season's really do. His hazard is the
   * league's scaled to how many games men with his recent history
   * play.
   */
  const absence = process.env["NO_ABSENCE"]
    ? undefined
    : await fitAbsence([SCORE_ON - 4, SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1]);
  const gamesBefore = new Map<string, number[]>();

  if (absence) {
    for (const back of [1, 2, 3]) {
      const seen = new Map<string, Set<number>>();

      for (const s of await loadPlayerStats(SCORE_ON - back).catch(() => [])) {
        if (s.week > 18) {
          continue;
        }

        const weeks = seen.get(s.playerId) ?? new Set<number>();
        weeks.add(s.week);
        seen.set(s.playerId, weeks);
      }

      for (const [playerId, weeks] of seen) {
        gamesBefore.set(playerId, [
          ...(gamesBefore.get(playerId) ?? []), weeks.size,
        ]);
      }
    }
  }

  const expectedFor = (playerId: string) => {
    const his = gamesBefore.get(playerId) ?? [];
    const mean = his.length
      ? his.reduce((a, b) => a + b, 0) / his.length
      : 15;
    const trust = his.length / (his.length + 1);

    return trust * mean + (1 - trust) * 15;
  };
  const seedOf = (playerId: string, run: number) => {
    let hash = SCORE_ON * 31 + run * 7919;

    for (let i = 0; i < playerId.length; i++) {
      hash = (hash * 131 + playerId.charCodeAt(i)) | 0;
    }

    return hash >>> 0;
  };
  const outRemembered = new Map<string, Set<number>>();
  const outWeeks = (playerId: string, position: string, run: number) => {
    const key = `${playerId}|${run}`;
    const already = outRemembered.get(key);

    if (already) {
      return already;
    }

    const draws = seededRng(seedOf(playerId, run));
    const hazard = absence!.hazardFor(position, expectedFor(playerId), 17);
    const out = new Set<number>();
    let downFor = 0;

    for (let week = 1; week <= 18; week++) {
      if (downFor > 0) {
        out.add(week);
        downFor--;
        continue;
      }

      if (draws() < hazard) {
        out.add(week);
        downFor = absence!.spellOf(position, draws) - 1;
      }
    }

    outRemembered.set(key, out);

    return out;
  };

  /**
   * Every reading there has ever been, so a fixture nobody has played
   * can still be given a day. Fitted on seasons before the one being
   * walked, so nothing reads its own weather.
   */
  const climate = fitClimate(
    (await loadGames())
      .filter((g) => g.season < SCORE_ON && !g.indoors &&
        g.temp !== undefined && g.week <= 18)
      .map((g): Reading => ({
        team: g.homeTeamId, week: g.week, hour: g.hour ?? 13,
        temperature: g.temp!, wind: g.wind,
      })),
  );

  for (const fixture of
    process.env["MERGED"] || process.env["PREWARM"] ? [] : mine) {
    const home = sideFor(fixture.homeTeamId);
    const away = sideFor(fixture.awayTeamId);

    if (!home || !away) {
      continue;
    }

    /**
     * The betting line orders team points at .39 where the walk alone
     * manages .135, so each side bends toward its implied total.
     * Seven tenths took back most of that ordering (.35) and was the
     * only strength that also improved the points error; a full
     * bend kept buying ordering by inflating scoring until the error
     * was worse than not listening at all.
     */
    const alpha = Number(process.env["ALPHA"] ?? 0.7);

    if (alpha > 0 &&
        fixture.totalLine !== undefined && fixture.spreadLine !== undefined) {
      home.lift = Math.pow(sizeOf(
        { total: fixture.totalLine, favouredBy: fixture.spreadLine },
      ), alpha);
      away.lift = Math.pow(sizeOf(
        { total: fixture.totalLine, favouredBy: -fixture.spreadLine },
      ), alpha);
    }

    /**
     * A season nobody has played has no readings, so a day is drawn for
     * it from what that ground is like in that week at that hour. It is
     * drawn once per run rather than once per fixture, so the walk sees
     * a mild December afternoon in Buffalo as often as a freezing one.
     */
    const drawVenue = () => ({
      indoors: fixture.indoors,
      temperature: fixture.temp ??
        (fixture.indoors
          ? undefined
          : climate.drawTemperature(
              fixture.homeTeamId, fixture.week, fixture.hour ?? 13, rng,
            )),
      wind: fixture.wind ??
        (fixture.indoors
          ? undefined
          : climate.drawWind(fixture.homeTeamId, rng)),
    });
    const meanFor = new Map<string, number>();
    const madeThisGame = new Map<string, StatTotals>();

    const saidPoints = new Map<string, number>();

    const marketLift = { home: home.lift, away: away.lift };

    for (let run = 0; run < RUNS; run++) {
      const venue = drawVenue();
      /**
       * The day, on top of whatever the line said, and off by default.
       * It looked worth having on 2025 and made 2024 worse, so the two
       * seasons disagree and nothing leans on it until they stop.
       */
      if (process.env["WEATHER"]) {
        const worth = weatherLift(venue);
        home.lift = (marketLift.home ?? 1) * worth;
        away.lift = (marketLift.away ?? 1) * worth;
      }
      droveHere.teamGames += 2;
      /**
       * The men down this week of this pass leave the field, and the
       * shares renormalise over whoever is left, so a backup inherits
       * the work for exactly the weeks the spell lasts.
       */
      const upNow = (side: typeof home) => {
        if (!absence) {
          return side;
        }

        const among = side.among.filter((id) =>
          !SHARING_POSITIONS.includes(positions.get(id) ?? "") ||
          !outWeeks(id, positions.get(id)!, run).has(fixture.week));

        return among.length === side.among.length
          ? side
          : { ...side, among };
      };
      const homeNow = upNow(home);
      const awayNow = upNow(away);
      const game = playGame(homeNow, awayNow, {
        rules: {
          ...rules, kickSucceeds: kicking.kickSucceeds,
          // the ground this fixture is played on, which changes both
          // the kick and whether they try one
          kickHere: (yardline: number) => kickingVenue.bend(yardline, venue),
          kickAppetite: kickingVenue.appetite(venue),
        },
        fourth,
        clock: { isLast: kicking.isLast, lastLength: kicking.lastLength },
        ticking, season: SCORE_ON, week: fixture.week,
      }, rng);

      for (const [playerId, line] of linesFrom(game, [homeNow, awayNow])) {
        const pts = fantasyPoints(line, RULES);
        meanFor.set(
          playerId,
          (meanFor.get(playerId) ?? 0) + pts / RUNS,
        );
        // every game he was dealt, kept whole, so his spread on the
        // card can be his own rather than a pooled band's
        const his = samples.get(playerId) ?? [];
        his.push(Math.round(pts * 10) / 10);
        samples.set(playerId, his);

        const made = madeThisGame.get(playerId) ?? blankTotals();

        for (const part of PARTS) {
          made[part] += (line[part] ?? 0) / RUNS;
        }

        madeThisGame.set(playerId, made);

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

      for (const one of game.possessions) {
        droveHere.drives++;
        droveHere.plays += one.drive.plays.length;
        droveHere.seconds += one.drive.took;
        droveHere.ends.set(one.drive.ending, (droveHere.ends.get(one.drive.ending) ?? 0) + 1);
        const n = Math.min(one.drive.plays.length, 12);
        droveHere.spread.set(n, (droveHere.spread.get(n) ?? 0) + 1);
        if (one.drive.plays.length <= 3) droveHere.quick++;
        droveHere.faced.push(...one.drive.facedAt);
        droveHere.startedAt += one.drive.plays[0]?.state.yardline ?? 0;

        for (const play of one.drive.plays) {
          droveHere.gained += play.yards;
          droveHere.calls++;

          if (play.call === "run") {
            droveHere.runYards += play.yards;
            droveHere.runs++;
          } else {
            droveHere.passYards += play.yards;
            droveHere.passes++;
          }
        }
        const its = kicksFor.get(one.team) ?? { from: [], conversions: 0 };

        if (one.drive.kickedFrom !== undefined) {
          its.from.push(one.drive.kickedFrom);
        }

        if (one.drive.ending === "touchdown") {
          its.conversions += 1 / RUNS;
        }

        kicksFor.set(one.team, its);
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

    for (const [playerId, made] of madeThisGame) {
      const so_far = madeOf.get(playerId) ?? blankTotals();

      for (const part of PARTS) {
        so_far[part] += made[part];
      }

      madeOf.set(playerId, so_far);
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
    if (process.env["REACH_CHECK"]) {
    watchHowFar();
  }

  if (process.env["DRIVE_CHECK"]) {
      const per = (n: number, of: number) => (n / Math.max(1, of)).toFixed(2);
      console.error(
        `  ${per(droveHere.drives, droveHere.teamGames)} drives a side ` +
        `(really 10.7), ${per(droveHere.plays, droveHere.drives)} plays a ` +
        `drive (really 5.98), ` +
        `${(droveHere.seconds / Math.max(1, droveHere.drives)).toFixed(0)} ` +
        `seconds (really 171)
  ends: ` +
        [...droveHere.ends.entries()].sort((a, b) => b[1] - a[1])
          .map(([e, n]) => `${e} ${(100 * n / droveHere.drives).toFixed(1)}%`)
          .join(", "),
      );
      console.error(
        `  three plays or fewer ` +
        `${(100 * droveHere.quick / droveHere.drives).toFixed(1)}% ` +
        `(really 33.7%)\n  plays a drive: ` +
        [...droveHere.spread.entries()].sort((a, b) => a[0] - b[0])
          .map(([n, c]) => `${n}:${(100 * c / droveHere.drives).toFixed(0)}%`)
          .join(" ") + `\n  really:        ` +
        `1:5% 2:3% 3:25% 4:9% 5:9% 6:10% 7:8% 8:7% 9:6% 10:5% 11:4% 12:8%`,
      );
      const truth: Record<string, string> = {
        "inside 20": "kick 69% punt 0% go 31%",
        "21-30": "kick 73% punt 0% go 27%",
        "31-40": "kick 54% punt 9% go 36%",
        "41-50": "kick 3% punt 64% go 33%",
        "past 50": "kick 0% punt 88% go 12%",
      };
      if (reached.length) {
        const truth: Record<number, [number, number]> = {
          10: [21.0, 68.9], 20: [31.6, 57.3], 30: [40.5, 49.1],
          40: [49.6, 42.4], 50: [58.7, 37.2],
        };
        console.error("  how far a drive got, and whether it scored");

        for (const b of [10, 20, 30, 40, 50]) {
          const got = reached.filter((d) => d.best <= b);
          const [reallyGot, reallyScored] = truth[b]!;
          console.error(
            `    reached the ${String(b).padStart(2)}: ` +
            `${(100 * got.length / reached.length).toFixed(1)}% of drives ` +
            `(really ${reallyGot}%), scoring ` +
            `${(100 * got.filter((d) => d.td).length / Math.max(1, got.length)).toFixed(1)}% ` +
            `(really ${reallyScored}%)`,
          );
        }
      }

      if (gainedAt.size) {
        const truth: Record<string, number> = {
          "inside 10": 1.80, "11-20": 4.09, "21-30": 5.13,
          "31-50": 5.80, "51-70": 5.99, "past 70": 6.03,
        };
        console.error("  yards a play, by where the ball is");

        for (const b of ["inside 10", "11-20", "21-30", "31-50", "51-70", "past 70"]) {
          const v = gainedAt.get(b);
          if (!v) continue;
          console.error(
            `    ${b.padEnd(10)} ${(v.yards / v.n).toFixed(2)} ` +
            `(really ${truth[b]!.toFixed(2)})`,
          );
        }
      }

      if (gaveUpAt.size) {
        console.error("  throws the sampled draw gave up on, by where the ball is");
        for (const b of ["inside 10", "11-20", "21-30", "31-50", "51-70", "past 70"]) {
          const v = gaveUpAt.get(b);
          if (!v) continue;
          console.error(
            `    ${b.padEnd(10)} ${(100 * v.pooled / v.n).toFixed(1)}% of ${v.n}`,
          );
        }
      }

      console.error("  on fourth down, by where the ball is");
      for (const b of ["inside 20", "21-30", "31-40", "41-50", "past 50"]) {
        const v = fourthsAt.get(b);
        if (!v) continue;
        console.error(
          `    ${b.padEnd(10)} n=${String(v.n).padStart(5)} ` +
          `kick ${(100 * v.kick / v.n).toFixed(0)}% ` +
          `punt ${(100 * v.punt / v.n).toFixed(0)}% ` +
          `go ${(100 * v.go / v.n).toFixed(0)}%   really ${truth[b]}`,
        );
      }
      const faced = [...droveHere.faced].sort((a, b) => a - b);
      const at = (q: number) => faced[Math.floor(q * faced.length)] ?? 0;
      console.error(
        `  fourth downs faced ${faced.length}, yards from the posts: ` +
        `a quarter inside ${at(0.25)}, half inside ${at(0.5)}, ` +
        `three quarters inside ${at(0.75)}\n  ` +
        `inside 40 (a kick) ` +
        `${(100 * faced.filter((y) => y <= 40).length / faced.length).toFixed(1)}%` +
        ` (really 37.4%)\n  starting ` +
        `${(droveHere.startedAt / Math.max(1, droveHere.drives)).toFixed(1)} out ` +
        `(really 70.6), so it makes ` +
        `${(droveHere.startedAt / Math.max(1, droveHere.drives) - at(0.5)).toFixed(1)} ` +
        `yards before a fourth down where a side really makes 19\n  ` +
        `${(droveHere.gained / Math.max(1, droveHere.calls)).toFixed(2)} a play ` +
        `(really 5.41), ` +
        `${(droveHere.runYards / Math.max(1, droveHere.runs)).toFixed(2)} a carry ` +
        `(really 4.50), ` +
        `${(droveHere.passYards / Math.max(1, droveHere.passes)).toFixed(2)} a pass ` +
        `(really 6.09, off a pool averaging 7.33)`,
      );
    }
    console.log(JSON.stringify({
      // how many times each fixture was played and how many fixtures a
      // side got, since the kicks come back as a raw count and only
      // these two turn it back into kicks a game
      runs: RUNS, weeks: gamesEachSideGets(schedule),
      total: [...total.entries()], games: [...games.entries()],
      made: [...madeOf.entries()],
      samples: [...samples.entries()],
      kicks: [...kicksFor.entries()].map(([team, its]) => [team, {
        // the attempts as distances, kept whole so a kicker's own
        // accuracy can be applied band by band
        from: its.from, conversions: its.conversions,
      }]),
    }));
    return;
  }

  } else {
    const merged = JSON.parse(
      await readFile(process.env["MERGED"], "utf8"),
    ) as {
      total: [string, number][]; games: [string, number][];
      made?: [string, StatTotals][];
    };

    for (const [playerId, points] of merged.total) {
      total.set(playerId, points);
    }

    for (const [playerId, n] of merged.games) {
      games.set(playerId, n);
    }

    for (const [playerId, made] of merged.made ?? []) {
      madeOf.set(playerId, made);
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
      if (s2.week <= 18) {
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
    if (s2.week > 18) {
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
    const plays = onlyWeek ? 1 : availOf(playerId);
    total.set(playerId, points * plays);
    const made = madeOf.get(playerId);

    if (made) {
      for (const part of PARTS) {
        made[part] *= plays;
      }
    }
  }

  // what they really scored, with the same rules
  const scored = new Map<string, number>();
  const names = new Map<string, string>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18 || (onlyWeek && s.week !== onlyWeek)) {
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
    if (s2.week > 18) {
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
      if (s2.week >= onlyWeek || s2.week > 18) {
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

// Builds the static weekly site into docs/: the page plus prediction
// JSON for the requested weeks, ready for GitHub Pages.
// Run: npx tsx scripts/buildSite.ts --league <sleeper id> --weeks 10-12

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  loadGames, loadPlayerStats, loadWeeklyRosters,
} from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyProspectiveForWeek,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildResidualModel, outcomeQuantile } from "../src/backtest/intervals.js";
import { normalizeName } from "../src/data/names.js";
import { parseCsv } from "../src/data/csv.js";
import { kickerParts, BANDS } from "../src/features/kickerFromWalk.js";
import { kickerSeason, type Fixture } from "../src/features/kickerSeason.js";
import { fitClimate } from "../src/features/climate.js";
import { readingsFrom, kickoffsIn } from "../src/data/gameWeather.js";
import { settingLift, sharedOut, type Setting } from "../src/features/weekSetting.js";
import {
  fetchLeagueScoring,
  fetchStarterSlots,
} from "../src/data/leagueScoring.js";
import {
  DEFAULT_SLOTS,
  replacementLevels,
} from "../src/features/replacement.js";
import { setScoring } from "../src/scoring/active.js";
import {
  scoringRules,
  fantasyPoints,
  type ScoringFormat,
} from "../src/scoring/fantasyPoints.js";
import { buildPreseasonWorld } from "../src/features/preseason.js";
import { simulatePlayerSeasons } from "../src/sim/playerSeason.js";
import { seededRng } from "../src/sim/rng.js";
import { loadAdp, loadSleeperAdp, type AdpFormat } from "../src/data/adp.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { simulateSeason, DEFAULT_SEASON } from "../src/model/seasonSim.js";
import { normalDraw } from "../src/sim/normal.js";
import { scoring } from "../src/scoring/active.js";
import { loadTendencies } from "../src/data/tendencies.js";
import {
  preseasonWeekly, anchorToSeason, type WeeklyProjection,
} from "../src/features/preseasonWeekly.js";
import {
  experienceBefore,
  pastShares,
  projectShares,
  SHARING_POSITIONS,
} from "../src/features/projectedShares.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import {
  blendedPlace, leanFor, placesBy, spreadOver,
} from "../src/features/boardOrder.js";
import { fitJoint, type Parts } from "../src/features/jointParts.js";
import { partsIn } from "../src/data/advancedParts.js";

/**
 * The site is the site, so it goes at the top rather than down a path
 * nobody would guess. The old address still works: a page there sends
 * anyone with the link on.
 */
const DOCS = join(import.meta.dirname, "..", "docs");
const OLD = join(DOCS, "weekly");

/** the season being drafted for; a new one starts in March */
const CURRENT_SEASON = new Date().getUTCFullYear() -
  (new Date().getUTCMonth() < 2 ? 1 : 0);

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1]!;
}

/**
 * Each man's place by one model over the parts of his play. A man the
 * advanced stat files have never seen is left out rather than guessed
 * at, and the blend gives his weight to the opinions that do have
 * something, which is how a rookie is handled.
 */
async function partsSays<T extends { position: string }>(
  board: T[],
  keyOf: (man: T) => string,
  idOf: Map<string, string>,
  season: number,
): Promise<Map<string, number>> {
  const learn: { parts: Parts; position: string; scored: number }[] = [];
  const positions = new Map<string, string>();

  for (let year = 2018; year < season - 1; year++) {
    const before = await partsIn(year);
    const after = new Map<string, { points: number; games: number }>();

    for (const s of await loadPlayerStats(year + 1)) {
      if (s.week > 18) {
        continue;
      }

      positions.set(s.playerId, s.position);
      const so = after.get(s.playerId) ?? { points: 0, games: 0 };
      so.points += fantasyPoints(s.statLine, scoring());
      so.games++;
      after.set(s.playerId, so);
    }

    for (const [who, his] of before) {
      const next = after.get(who);

      if (!next || next.games < 6 || his.games < 4) {
        continue;
      }

      learn.push({
        parts: his,
        position: positions.get(who) ?? "WR",
        scored: next.points / next.games,
      });
    }
  }

  const fitted = fitJoint(learn);
  const lastYear = await partsIn(season - 1);
  const said = new Map<string, number>();

  for (const man of board) {
    const id = idOf.get(keyOf(man));
    const his = id === undefined ? undefined : lastYear.get(id);

    if (his) {
      said.set(keyOf(man), fitted.says(his, man.position));
    }
  }

  console.log(
    `his parts speak for ${said.size} of ${board.length} on the board, ` +
    `taught on ${learn.length} seasons of men`,
  );

  return placesBy(
    board.filter((man) => said.has(keyOf(man))), keyOf,
    (man) => said.get(keyOf(man)) ?? null,
  );
}

async function main(): Promise<void> {
  const season = Number(argOf("--season", String(CURRENT_SEASON)));
  const leagueId = argOf("--league", "");
  const format = argOf("--scoring", "");
  // The draft board has to match the draft. A point a catch moves
  // receivers up the order, so a standard league needs the standard
  // mocks or every alternative it prices is the wrong man.
  let adpFormat: AdpFormat = "ppr";

  if (leagueId) {
    const rules = await fetchLeagueScoring(leagueId);
    setScoring(rules);
    adpFormat = rules.receptions >= 0.5 ? "ppr" : "standard";
    console.log(
      `scoring from league ${leagueId}: ${rules.receptions} per catch, ` +
        `${rules.passTd} per passing touchdown`,
    );
    console.log(`draft board: ${adpFormat} mocks`);
  } else if (format) {
    const rules = scoringRules(format as ScoringFormat);
    setScoring(rules);
    adpFormat = rules.receptions >= 0.5 ? "ppr" : "standard";
    console.log(`scoring: ${format}`);
  } else {
    console.warn(
      "no --league or --scoring given, so the board is scored PPR, " +
        "which is wrong for most leagues",
    );
  }

  console.log(`building the ${season} board`);
  const weeksArg = argOf("--weeks", "");
  const range = weeksArg.match(/^(\d+)-(\d+)$/);
  const weeks = weeksArg === ""
    ? []
    : range
    ? Array.from(
        { length: Number(range[2]) - Number(range[1]) + 1 },
        (_, i) => Number(range[1]) + i,
      )
      : weeksArg.split(",").map(Number);

  const games = await loadGames();
  const train: WeeklyExample[] = [];

  for (let s = 2016; s < season; s++) {
    train.push(...(await weeklyExamplesForSeason(s, games)));
  }

  const weights = fitRidge(train.map(weeklyRow), train.map((e) => e.target), 25);
  const residuals = buildResidualModel(
    train.map((e) => ({
      position: e.position,
      predicted: predictRidge(weights, weeklyRow(e)),
      actual: e.target,
    })),
    5,
  );

  await mkdir(join(DOCS, "data"), { recursive: true });

  const index: { season: number; week: number }[] = [];

  for (const week of weeks) {
    const rows = (await weeklyProspectiveForWeek(season, week, games))
      .map((e) => {
        const predicted = predictRidge(weights, weeklyRow(e));
        return {
          name: e.playerName,
          key: normalizeName(e.playerName),
          position: e.position,
          team: e.teamId,
          opponent: (e.home ? "v " : "@ ") + e.opponent,
          predicted: Number(predicted.toFixed(1)),
          floor: Number(
            outcomeQuantile(residuals, e.position, predicted, 0.1).toFixed(1),
          ),
          ceiling: Number(
            outcomeQuantile(residuals, e.position, predicted, 0.9).toFixed(1),
          ),
          snaps: Math.round(e.snapRecent * 100),
        };
      })
      .sort((a, b) => b.predicted - a.predicted);

    await writeFile(
      join(DOCS, "data", `slate-${season}-${week}.json`),
      JSON.stringify({ season, week, players: rows }),
    );
    index.push({ season, week });
    console.log(`week ${week}: ${rows.length} players`);
  }

  // season draft board with replacement value, for the draft view
  const world = await buildPreseasonWorld(season);

  const { projectDraftExamples } = await import("../src/features/seasonModel.js");
  const draftExamples = await projectDraftExamples(season, world.data);
  const exampleById = new Map(draftExamples.map((e) => [e.playerId, e]));

  const weekOpp = new Map<string, { week: number; opponent: string; home: boolean }[]>();

  for (const game of world.games) {
    // a season runs to week 18 and a side plays seventeen of them, so
    // cutting at seventeen dropped everyone's last game
    if (game.season !== season || game.week > 18) {
      continue;
    }

    for (const [team, opponent, home] of [
      [game.homeTeamId, game.awayTeamId, true],
      [game.awayTeamId, game.homeTeamId, false],
    ] as [string, string, boolean][]) {
      const list = weekOpp.get(team) ?? [];
      list.push({ week: game.week, opponent, home });
      weekOpp.set(team, list);
    }
  }

  // where and when each fixture is played, so a kicker's week can be a
  // freezing night in Buffalo rather than another mild afternoon
  const gameRows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
  const climate = fitClimate(readingsFrom(gameRows));
  const fixturesFor = new Map<string, Fixture[]>();

  for (const k of kickoffsIn(gameRows, season)) {
    for (const team of [k.homeTeam, k.awayTeam]) {
      fixturesFor.set(team, [
        ...(fixturesFor.get(team) ?? []),
        { week: k.week, host: k.homeTeam, hour: k.hour },
      ]);
    }
  }

  const whereEach = new Map<string, Setting>();

  for (const k of kickoffsIn(gameRows, season)) {
    const indoors = k.indoors;

    for (const [team, rest] of [
      [k.homeTeam, k.homeRest], [k.awayTeam, k.awayRest],
    ] as [string, number][]) {
      whereEach.set(`${team}|${k.week}`, {
        indoors, night: k.hour >= 18, restDays: rest,
      });
    }
  }

  const settingOf = (team: string, week: number): Setting =>
    whereEach.get(`${team}|${week}`) ??
      { indoors: false, night: false, restDays: 7 };

  const factors = (playerId: string, ppg: number) => {
    const e = exampleById.get(playerId);
    const plus: string[] = [];
    const minus: string[] = [];

    if (!e) {
      return { plus, minus };
    }

    if (e.moved) {
      minus.push("changed teams; movers keep about 89% of production");
    }

    if (e.group === "skill-stayer-new-qb") {
      minus.push("new starting quarterback");
    }

    if (e.hcChanged) {
      minus.push("new coaching regime; stayers under one keep about 96%");
    } else if (e.ocChanged) {
      plus.push("coordinator change under the same head coach, historically harmless");
    }

    if (e.ocReunion) {
      plus.push("reunited with a former coordinator");
    }

    if (e.age !== undefined && e.age >= 29) {
      minus.push(e.position === "RB" ? `age ${e.age}, past the RB cliff` : `age ${e.age}`);
    }

    if (e.expYears !== undefined && e.expYears <= 3) {
      plus.push("years one to three, when players typically improve");
    }

    if (e.gamesPrev <= 12) {
      minus.push(`only ${e.gamesPrev} games last season`);
    }

    if (e.tdPointShare >= 0.45) {
      minus.push("touchdown-heavy scoring, which regresses");
    }

    if (e.rookieCapital >= 0.5) {
      minus.push("team drafted a high pick at his position");
    }

    if (e.targetsPerGame >= 7) {
      plus.push(`${e.targetsPerGame.toFixed(1)} targets a game, and volume repeats`);
    }

    if (e.carriesPerGame >= 14) {
      plus.push(`${e.carriesPerGame.toFixed(1)} carries a game, a workhorse role`);
    }

    if (e.prevPpg > 0 && ppg > e.prevPpg + 1) {
      plus.push(`model projects ${ppg.toFixed(1)}, above last season's ${e.prevPpg.toFixed(1)}`);
    } else if (e.prevPpg > 0 && ppg < e.prevPpg - 1.5) {
      minus.push(`model projects ${ppg.toFixed(1)}, below last season's ${e.prevPpg.toFixed(1)}`);
    }

    return { plus, minus };
  };
  const slots = leagueId
    ? await fetchStarterSlots(leagueId)
    : DEFAULT_SLOTS;

  if (!leagueId) {
    console.warn(
      "no --league given, so value over replacement uses a generic " +
        "12-team lineup rather than your league's",
    );
  }

  const pool = world.players.map((p) => ({
    position: p.position,
    ppg: p.projectedPpg,
  }));
  const { levels, starters } = replacementLevels(pool, slots);
  console.log(
    "replacement level: " +
      Object.keys(levels)
        .map((position) =>
          `${position} ${levels[position]!.toFixed(1)} after ${starters[position]} start`,
        )
        .join(", "),
  );
  const replacement = new Map(Object.entries(levels));

  const adp = await loadAdp(season, adpFormat).catch(() => new Map());
  /**
   * Both sets of mocks, since a page serving more than one league
   * cannot know at build time which one the room is drafting from. A
   * point a catch moves receivers up the order, so a ppr league
   * reading standard mocks is reading the wrong draft.
   */
  const adpBoth = new Map<string, Record<string, unknown>>();

  for (const named of ["standard", "half", "ppr"] as const) {
    // the mocks, for their spread; they have no half point set of
    // their own, so the full point one is used for it
    const mocks = await loadAdp(
      season, (named === "ppr" ? "ppr" : "standard") as AdpFormat,
    ).catch(() => new Map());
    const room = await loadSleeperAdp(season, named).catch(() => new Map());

    for (const key of new Set([...room.keys(), ...mocks.keys()])) {
      const his = room.get(key);
      const mocked = mocks.get(key);
      const at = his?.adp ?? mocked?.adp;

      if (!at) {
        continue;
      }

      /**
       * Sleeper says where he goes and says nothing about how much
       * that moves, so the mocks' own spread is carried across as a
       * share of their number.
       */
      const spread = mocked && mocked.adp > 0
        ? { high: mocked.high / mocked.adp, low: mocked.low / mocked.adp }
        : { high: 0.75, low: 1.25 };
      const already = adpBoth.get(key) ?? {};
      already[named] = {
        adp: Number(at.toFixed(1)),
        high: Math.max(1, Math.round(at * spread.high)),
        low: Math.round(at * spread.low),
        from: his ? "sleeper" : "mocks",
      };
      adpBoth.set(key, already);
    }
  }

  /**
   * How much of his offence each man is projected to touch.
   *
   * The regression asks what a player did and what has changed around
   * him. This asks a different question: of the work his position
   * group has to give out, how much does he win against the men he is
   * competing with. The two disagree about different players, which
   * is why mixing both with the market beats mixing either.
   */
  const touchesFor = new Map<string, number>();

  try {
    const ranPlays = new Map<string, number>();
    const { parseCsv: readPlays } = await import("../src/data/csv.js");

    for (const row of readPlays(await readFile(
      join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
    ))) {
      if (!["run", "pass"].includes(row["playType"] ?? "")) {
        continue;
      }

      const key = `${row["season"]}|${row["offense"]}`;
      ranPlays.set(key, (ranPlays.get(key) ?? 0) + 1);
    }

    const roster = world.players
      .filter((p) => SHARING_POSITIONS.includes(p.position))
      .map((p) => ({ playerId: p.playerId, position: p.position, team: p.teamId }));
    const shares = projectShares({
      season, roster,
      past: await pastShares(
        [season - 3, season - 2, season - 1],
        (s, team) => ranPlays.get(`${s}|${team}`) ?? 1000,
      ),
      picks: await loadDraftPicks(),
      experience: await experienceBefore(season),
    });

    for (const man of roster) {
      const share = shares.get(man.playerId);

      if (share !== undefined) {
        touchesFor.set(
          man.playerId, share * (ranPlays.get(`${season - 1}|${man.team}`) ?? 1000),
        );
      }
    }

    console.log(`projected touches for ${touchesFor.size} players`);
  } catch (error) {
    console.warn("no share projection, so the board is the old two-way mix: " + error);
  }

  /**
   * The shape of a player's week, from the situational simulation.
   *
   * The pooled residual model gives every player at a scoring level
   * the same band, so two receivers projected the same got the same
   * range whatever their roles. The simulation gives each his own,
   * calibrated at 79.6% inside an 80% band against 80.1% for the
   * pooled one and on a band 14% narrower.
   *
   * It orders players worse than the season model, .72 against .788,
   * so the level stays where it is and only the shape is taken. Each
   * man's simulated spread is scaled to sit around his projection.
   */
  const shapeOf = new Map<string, { q1: number; q3: number; low: number; high: number }>();

  try {
    const positions = new Map<string, string>();
    const gamesLast = new Map<string, number>();

    for (const row of await loadPlayerStats(season - 1)) {
      positions.set(row.playerId, row.position);
      gamesLast.set(row.playerId, (gamesLast.get(row.playerId) ?? 0) + 1);
    }

    const { byTeam, playsByTeam } = await fitRoles(season - 1, positions, gamesLast);
    const rng = seededRng(29);
    const draws = { uniform: rng, normal: () => normalDraw(rng) };

    for (const [team, roster] of byTeam) {
      // No role drift here. The card says middle half of games, which
      // is a statement about his weeks given the role he has, not
      // about our doubt over what that role will be. Pooling across
      // role draws made a receiver's middle half twice as wide as any
      // receiver's really is.
      const simulated = simulateSeason(
        { plays: playsByTeam.get(team)! }, roster,
        { ...DEFAULT_SEASON, runs: 400, roleDrift: 0, scoring: scoring() }, draws,
      );

      for (const player of simulated) {
        const middle = player.weekly.median;

        if (middle <= 0) {
          continue;
        }

        // as a share of his own median, so it can be hung on the
        // season model's projection rather than the simulation's
        shapeOf.set(player.playerId, {
          q1: player.weekly.p25 / middle,
          q3: player.weekly.p75 / middle,
          low: player.weekly.p10 / middle,
          high: player.weekly.p90 / middle,
        });
      }
    }

    console.log(`shapes from the simulation for ${shapeOf.size} players`);
  } catch (error) {
    console.warn("no simulated shapes, falling back to the pooled bands: " + error);
  }

  /**
   * Each man's weeks from the weekly model rather than from his
   * season average times a blunted opponent. The two order a week
   * about equally well, but this one is the model that was measured,
   * and it says what it thinks of a matchup rather than what a
   * constant chosen by hand says.
   */
  const teamScored = new Map<string, { points: number; weeks: Set<number> }>();

  for (const w of await loadPlayerStats(season - 1)) {
    const entry = teamScored.get(w.teamId) ?? { points: 0, weeks: new Set<number>() };
    entry.points += fantasyPoints(w.statLine, scoring());
    entry.weeks.add(w.week);
    teamScored.set(w.teamId, entry);
  }

  const passRate = new Map<string, number>();

  for (const [key, tendency] of await loadTendencies()) {
    const [team, at] = key.split("|");

    if (Number(at) === season - 1) {
      passRate.set(team!, tendency.neutralPassRate);
    }
  }

  const weeklyByPlayer = new Map<string, WeeklyProjection[]>();
  const saidWeekly = preseasonWeekly({
    season, games: world.games, weeklyWeights: world.weeklyWeights,
    projectedPpg: new Map(world.players.map((p) => [p.playerId, p.projectedPpg])),
    exampleById,
    positionById: new Map(world.players.map((p) => [p.playerId, p.position])),
    teamById: new Map(world.players.map((p) => [p.playerId, p.teamId])),
    oppAdjust: world.oppAdjust, oppIndex: world.oppIndex,
    teamScoring: new Map([...teamScored].map(([team, e]) =>
      [team, e.points / Math.max(1, e.weeks.size)])),
    passRate,
  });

  for (const p of world.players) {
    const his = saidWeekly.get(p.playerId);

    if (!his) {
      continue;
    }

    // the opponent is most of what the weekly model has to go on and it
    // is a weak thing to know in August, so the roof and the kickoff
    // time do a lot of the work here
    const lifts = sharedOut(his.map((w) =>
      settingLift(p.position, settingOf(p.teamId, w.week))));

    weeklyByPlayer.set(p.playerId, anchorToSeason(
      his.map((w, i) => ({ ...w, points: w.points * lifts[i]! })),
      p.projectedPpg,
    ));
  }

  console.log("simulating seasons for the board...");
  const sims = simulatePlayerSeasons(
    world.players,
    season,
    world.games,
    world.residuals,
    world.oppAdjust,
    world.catcherLoading,
    2000,
    seededRng(17),
    world.seasonNoise,
  );
  const simById = new Map(sims.map((s) => [s.playerId, s]));

  const board = world.players
    .map((p) => {
      const f = factors(p.playerId, p.projectedPpg);
      const sim = simById.get(p.playerId);
      const shape = shapeOf.get(p.playerId);
      const pooled = (q: number) =>
        Math.max(0, outcomeQuantile(world.residuals, p.position, p.projectedPpg, q));
      // his own shape when the simulation knows him, the pooled band
      // when it does not
      const perGame = (q: number, from?: number) =>
        Number(
          (shape && from !== undefined
            ? Math.max(0, p.projectedPpg * from)
            : pooled(q)
          ).toFixed(1),
        );
      return {
        name: p.name,
        key: normalizeName(p.name),
        position: p.position,
        team: p.teamId,
        ppg: Number(p.projectedPpg.toFixed(1)),
        // what the regression expects him to do in a game, for the page
        // to score by whatever the connected league pays
        projected: p.projectedParts
          ? Object.fromEntries(Object.entries(p.projectedParts)
              .map(([part, n]) => [part, Number(n.toFixed(2))]))
          : null,
        vor: Number(
          (p.projectedPpg - (replacement.get(p.position) ?? 0)).toFixed(1),
        ),
        touches: touchesFor.has(p.playerId)
          ? Math.round(touchesFor.get(p.playerId)!)
          : null,
        adp: adp.get(`${normalizeName(p.name)}|${p.position}`)?.adp ?? null,
        adpLow: adp.get(`${normalizeName(p.name)}|${p.position}`)?.low ?? null,
        adpHigh: adp.get(`${normalizeName(p.name)}|${p.position}`)?.high ?? null,
        // and where each kind of room takes him, for the page to pick
        adpBy: adpBoth.get(`${normalizeName(p.name)}|${p.position}`) ?? null,
        bye: world.byeWeek.get(p.teamId) ?? null,
        rookie: p.rookie ?? false,
        game: {
          ev: Number(p.projectedPpg.toFixed(1)),
          q1: perGame(0.25, shape?.q1),
          mid: Number(p.projectedPpg.toFixed(1)),
          q3: perGame(0.75, shape?.q3),
          low: perGame(0.1, shape?.low),
          high: perGame(0.9, shape?.high),
        },
        shaped: Boolean(shape),
        sim: sim
          ? {
              ev: Math.round(sim.meanTotal),
              q1: Math.round(sim.p25),
              mid: Math.round(sim.p50),
              q3: Math.round(sim.p75),
              low: Math.round(sim.p10),
              high: Math.round(sim.p90),
              games: Number(sim.meanGames.toFixed(1)),
            }
          : null,
        plus: f.plus,
        minus: f.minus,
        // A week as a multiple of his own average, since points here
        // would be points under one league's scoring. The weekly model
        // was fitted on points, so every part of his line moves together.
        // A man projected at nothing has no average to be a multiple of,
        // and saying his every week is a flat one is closer than saying
        // he scores nothing in all of them.
        weeks: (weeklyByPlayer.get(p.playerId) ?? [])
          .map((w) => ({
            w: w.week,
            opp: (w.home ? "v " : "@ ") + w.opponent,
            of: p.projectedPpg >= 1
              ? Number((w.points / p.projectedPpg).toFixed(3))
              : 1,
          })),
      };
    })
    .sort((a, b) => b.vor - a.vor);

  /**
   * Kickers and defences, which the rest of the model has nothing to
   * say about.
   *
   * A kicker is scored from what he actually kicked last season, by
   * distance, under the usual rules. A defence is ordered by the
   * points it gave up, since sacks and takeaways would need the play
   * by play and it is a last round pick either way. Both carry their
   * draft position, which is what most rooms go by anyway.
   */
  const lastSeason = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "raw", `stats_player_week_${season - 1}.csv`),
    "utf8",
  ).catch(() => ""));
  interface Tally { [part: string]: number }
  const kicked = new Map<string, {
    name: string; team: string; games: number; parts: Tally;
  }>();
  const defended = new Map<string, { parts: Tally }>();
  const num = (row: Record<string, string | undefined>, key: string) =>
    Number(row[key] ?? 0) || 0;

  /**
   * Who is on each defence this year, so last season's work follows
   * the man rather than the shirt. A club that lost its pass rush
   * should not be projected to rush the passer.
   */
  const playsFor = new Map<string, string>();

  for (const row of await loadWeeklyRosters(season).catch(() => [])) {
    if (!playsFor.has(row.playerId)) {
      playsFor.set(row.playerId, row.teamId);
    }
  }

  for (const row of lastSeason) {
    if (Number(row["week"]) > 18) {
      continue;
    }

    const team = row["team"] ?? "";

    if (row["position"] === "K") {
      const id = row["player_id"] ?? "";
      const his = kicked.get(id) ?? {
        name: row["player_display_name"] ?? id, team, games: 0,
        parts: {} as Tally,
      };
      his.games++;
      his.team = playsFor.get(id) ?? team;
      const add = (part: string, n: number) => {
        his.parts[part] = (his.parts[part] ?? 0) + n;
      };
      add("fgmYds", num(row, "fg_made_distance"));
      add("xpm", num(row, "pat_made"));
      add("xpmiss", num(row, "pat_missed"));

      for (const band of ["0_19", "20_29", "30_39", "40_49", "50_59"]) {
        add(`fgm_${band}`, num(row, `fg_made_${band}`));
        add(`fgmiss_${band}`, num(row, `fg_missed_${band}`));
      }

      add("fgm_60p", num(row, "fg_made_60_"));
      add("fgmiss_60p", num(row, "fg_missed_60_"));
      kicked.set(id, his);
    }

    // his work counts for whoever he plays for now
    const now = playsFor.get(row["player_id"] ?? "") ?? team;

    if (!now) {
      continue;
    }

    const its = defended.get(now) ?? { parts: {} as Tally };

    const add = (part: string, n: number) => {
      its.parts[part] = (its.parts[part] ?? 0) + n;
    };
    add("sack", num(row, "def_sacks"));
    add("int", num(row, "def_interceptions"));
    add("fum_rec", num(row, "def_fumbles"));
    add("def_td", num(row, "def_tds"));
    add("safe", num(row, "def_safeties"));
    add("blk_kick",
      num(row, "def_punt_blocks") + num(row, "def_fg_blocks") +
      num(row, "def_pat_blocks"));
    defended.set(now, its);
  }

  const allowed = new Map<string, { points: number[]; }>();

  for (const g of world.games) {
    if (g.season !== season - 1 || g.homeScore === undefined) {
      continue;
    }

    for (const [team, got] of [
      [g.homeTeamId, g.awayScore ?? 0], [g.awayTeamId, g.homeScore ?? 0],
    ] as [string, number][]) {
      const seen = allowed.get(team) ?? { points: [] };
      seen.points.push(got);
      allowed.set(team, seen);
    }
  }

  /**
   * Sleeper drafts a defence under the club's full name, so the rows
   * are found by the code at the end of it rather than by a name we
   * would have to keep a table of.
   */
  const byTeamCode = new Map<string, unknown>();

  for (const [key, at] of adpBoth) {
    if (!key.endsWith("|DEF")) {
      continue;
    }

    const said = key.slice(0, -4);

    for (const team of allowed.keys()) {
      if (normalizeName(team) === said) {
        byTeamCode.set(team, at);
      }
    }
  }

  const others: Record<string, unknown>[] = [];

  /**
   * The kicks each side is expected to take, from the season played
   * out. A drive that stalls in range is an attempt from where it
   * stalled, and one that scores is a conversion instead.
   */
  const walkFile = await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${season}.json`),
    "utf8",
  ).catch(() => "");
  const walked = walkFile
    ? JSON.parse(walkFile) as {
        runs?: number; weeks?: number;
        kicks?: [string, { from: number[]; conversions: number }][];
      }
    : {};
  const kicksOf = new Map(walked.kicks ?? []);
  /**
   * The kicks come back as a raw count across every run of every
   * fixture, so turning them into kicks a game needs both numbers. The
   * walk writes them down now; a file from before it did gets what the
   * walk used to run at.
   */
  const walkRuns = walked.runs ?? 40;
  const walkWeeks = walked.weeks ?? 17;
  const runsOver = walkWeeks * walkRuns;

  /**
   * One kicker a side. Where two are on the roster the one who took
   * more of them last season gets the attempts, since a club does not
   * split them.
   */
  const kicksHere = new Map<string, typeof kicked extends Map<string, infer V> ? V : never>();

  for (const [, his] of kicked) {
    const already = kicksHere.get(his.team);

    if (!already || (his.parts["xpm"] ?? 0) + (his.parts["fgmYds"] ?? 0) >
        (already.parts["xpm"] ?? 0) + (already.parts["fgmYds"] ?? 0)) {
      kicksHere.set(his.team, his);
    }
  }

  /**
   * What a kicker who keeps the job plays. Three seasons of them come
   * out at a shade over fifteen, and giving him a full seventeen while
   * every skill player is cut to his own availability made a kicker's
   * season look worth more than it is.
   */
  const KICKER_GAMES = 15.3;
  /** what a kicker makes from an extra point, and how many settle him */
  const LEAGUE_EXTRA_POINT = 0.958;
  const EXTRA_POINTS_SETTLE = 25;

  const extraPointRateOf = (made: number, missed: number) => {
    const taken = made + missed;
    const trust = taken / (taken + EXTRA_POINTS_SETTLE);

    return trust * (taken > 0 ? made / taken : LEAGUE_EXTRA_POINT) +
      (1 - trust) * LEAGUE_EXTRA_POINT;
  };

  for (const [, his] of kicked) {
    if (his.games < 6 || kicksHere.get(his.team) !== his) {
      continue;
    }

    const key = normalizeName(his.name);
    const its = kicksOf.get(his.team);
    const asHim = {
      attempts: his.parts["attempts"] ?? 0,
      made: his.parts["made"] ?? 0,
      byBand: BANDS.map((band) => ({
        attempts: (his.parts[`fgm_${band.name}`] ?? 0) +
          (his.parts[`fgmiss_${band.name}`] ?? 0),
        made: his.parts[`fgm_${band.name}`] ?? 0,
      })),
      // leaned toward what every kicker makes until he has taken
      // enough of them, the same way his field goals are. A man who
      // went thirty from thirty is not a certainty next year.
      extraPointRate: extraPointRateOf(
        his.parts["xpm"] ?? 0, his.parts["xpmiss"] ?? 0,
      ),
    };
    // his season played out game by game, so his card carries a spread
    // and a season total like anybody else's
    const walked = its
      ? kickerSeason(
          asHim,
          its.from.map((yardline) => yardline + 17),
          its.conversions * walkRuns,
          runsOver,
          KICKER_GAMES,
          // the weeks are read one against another, and at 2000 the
          // sampling alone moved them 9%, which is a third of what the
          // weather does. This puts the noise under 2%.
          20000,
          seededRng(29),
          (fixturesFor.get(his.team) ?? []).sort((a, b) => a.week - b.week),
          climate,
        )
      : null;
    const asKicked = its
      ? kickerParts(
          {
            attempts: his.parts["attempts"] ?? 0,
            made: his.parts["made"] ?? 0,
            byBand: BANDS.map((band) => ({
              attempts: (his.parts[`fgm_${band.name}`] ?? 0) +
                (his.parts[`fgmiss_${band.name}`] ?? 0),
              made: his.parts[`fgm_${band.name}`] ?? 0,
            })),
            extraPointRate: (his.parts["xpm"] ?? 0) > 0
              ? (his.parts["xpm"] ?? 0) /
                Math.max(1, (his.parts["xpm"] ?? 0) + (his.parts["xpmiss"] ?? 0))
              : 0.96,
          },
          its.from.map((yardline) => yardline + 17),
          its.conversions * walkRuns,
          runsOver,
        )
      : null;

    others.push({
      name: his.name, key, position: "K", team: his.team,
      // what the walk hands him, with what he did last season beside it
      simulated: walked?.parts ?? asKicked ?? Object.fromEntries(
        Object.entries(his.parts)
          .map(([part, n]) => [part, Number((n / his.games).toFixed(3))]),
      ),
      game: walked?.game ?? null,
      sim: walked?.sim ?? null,
      weeks: (weekOpp.get(his.team) ?? []).map((w) => ({
        w: w.week,
        opp: (w.home ? "v " : "@ ") + w.opponent,
        of: walked?.byWeek.find((b) => b.w === w.week)?.of ?? 1,
      })),
      lastYear: Object.fromEntries(Object.entries(his.parts)
        .map(([part, n]) => [part, Number((n / his.games).toFixed(3))])),
      fromWalk: Boolean(asKicked),
      adpBy: adpBoth.get(`${key}|K`) ?? null,
      bye: world.byeWeek.get(his.team) ?? null,
    });
  }

  /**
   * How often a defence held a side to each bracket, since the ladder
   * pays by bracket and an average would land in the wrong one.
   */
  const bracketOf = (points: number) =>
    points < 1 ? "pts_allow_0" : points <= 6 ? "pts_allow_1_6"
      : points <= 13 ? "pts_allow_7_13" : points <= 20 ? "pts_allow_14_20"
      : points <= 27 ? "pts_allow_21_27" : points <= 34 ? "pts_allow_28_34"
      : "pts_allow_35p";

  for (const [team, its] of defended) {
    // a season's work from the men who play there now, over a season
    const games = 17;
    const gave = allowed.get(team)?.points ?? [];
    const made: Record<string, number> = Object.fromEntries(
      Object.entries(its.parts).map(([part, n]) => [part, n / games]),
    );

    for (const got of gave) {
      made[bracketOf(got)] = (made[bracketOf(got)] ?? 0) + 1 / gave.length;
    }

    others.push({
      name: team, key: normalizeName(team), position: "DEF", team,
      simulated: made,
      adpBy: byTeamCode.get(team) ?? null,
      bye: world.byeWeek.get(team) ?? null,
    });
  }

  console.log(
    `and ${others.filter((o) => o["position"] === "K").length} kickers, ` +
      `${others.filter((o) => o["position"] === "DEF").length} defences`,
  );

  /**
   * The games played out, when a season of them has been kept. Absent
   * men keep their weight with the other opinions, the way every
   * silent opinion is treated.
   */
  const playedFile = await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${season}.json`),
    "utf8",
  ).catch(() => "");
  const played = playedFile
    ? JSON.parse(playedFile) as {
        total: [string, number][];
        games: [string, number][];
        made?: [string, Record<string, number>][];
      }
    : { total: [], games: [], made: [] };
  const walkSays = new Map<string, number>(played.total);
  const walkGames = new Map<string, number>(played.games);
  const walkMade = new Map<string, Record<string, number>>(played.made ?? []);
  const idOf = new Map(world.players.map((p) => [normalizeName(p.name), p.playerId]));

  const keyOf = (p: (typeof board)[number]) => p.key;
  /**
   * The regression is the reference the others are measured against
   * because it is the only one with something to say about every man.
   * Each opinion then goes onto the board's scale, since adp prices
   * the front 200 and the walk sees 700 and their places do not mean
   * the same thing until they are moved onto one.
   */
  const everyone = placesBy(board, keyOf, (p) => p.vor);
  const onBoard = (of: Map<string, number>) => spreadOver(of, everyone);
  const partsPlace = onBoard(
    await partsSays(board, keyOf, idOf, season),
  );
  const sharePlace = onBoard(placesBy(board, keyOf, (p) => p.touches));
  const adpPlace = onBoard(
    placesBy(board, keyOf, (p) => (p.adp === null ? null : -p.adp)),
  );
  const walkPlace = onBoard(placesBy(board, keyOf, (p) => {
    const id = idOf.get(p.key);
    const says = id === undefined ? undefined : walkSays.get(id);
    return says === undefined ? null : says;
  }));

  if (walkSays.size) {
    console.log(`the played games speak for ${walkPlace.size} of the board`);
  }

  /**
   * What the walk says he does in a game, before anybody scores it.
   *
   * A league paying a point a catch orders receivers differently from
   * one paying nothing, so the parts travel and the page applies its
   * own rules to them.
   */
  for (const p of board) {
    const id = idOf.get(p.key);
    const made = id === undefined ? undefined : walkMade.get(id);
    const played = id === undefined ? 0 : walkGames.get(id) ?? 0;

    if (made && played > 0) {
      (p as unknown as { simulated: Record<string, number> }).simulated =
        Object.fromEntries(Object.entries(made)
          .map(([part, n]) => [part, Number((n / played).toFixed(2))]));
    }
  }

  for (const p of board) {
    (p as unknown as { blend: number }).blend = blendedPlace({
      parts: partsPlace.get(p.key),
      model: everyone.get(p.key),
      share: sharePlace.get(p.key),
      adp: adpPlace.get(p.key),
      walk: walkPlace.get(p.key),
    }, leanFor(p.position));
  }

  board.sort(
    (a, b) =>
      (a as unknown as { blend: number }).blend -
      (b as unknown as { blend: number }).blend,
  );

  await writeFile(
    join(DOCS, "data", `board-${season}.json`),
    JSON.stringify({ season, players: [...board, ...others] }),
  );
  console.log(`board: ${board.length} players`);

  await writeFile(
    join(DOCS, "data", "index.json"),
    JSON.stringify({ weeks: index, boardSeason: season, adpFormat }),
  );
  await mkdir(OLD, { recursive: true });
  await writeFile(
    join(OLD, "index.html"),
    '<!doctype html><meta charset="utf-8">' +
      '<meta http-equiv="refresh" content="0; url=../">' +
      '<title>moved</title><p>The draft board is <a href="../">up a level' +
      "</a> now.</p>",
  );

  // The page is a Preact app now, so typescript checks it and vite
  // writes it. A crash used to reach the site because nothing but the
  // browser ever read the script.
  execFileSync("npx", ["tsc", "--noEmit", "-p", "app/tsconfig.json"], {
    cwd: join(import.meta.dirname, ".."),
    stdio: "inherit",
  });
  execFileSync("npx", ["vite", "build"], {
    cwd: join(import.meta.dirname, ".."),
    stdio: "inherit",
  });
  console.log(`site written to ${DOCS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

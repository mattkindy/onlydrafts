// Builds the static weekly site into docs/: the page plus prediction
// JSON for the requested weeks, ready for GitHub Pages.
// Run: npx tsx scripts/buildSite.ts --league <sleeper id> --weeks 10-12

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyProspectiveForWeek,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildResidualModel, outcomeQuantile } from "../src/backtest/intervals.js";
import { normalizeName } from "../src/data/names.js";
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
  type ScoringFormat,
} from "../src/scoring/fantasyPoints.js";
import { buildPreseasonWorld } from "../src/features/preseason.js";
import { simulatePlayerSeasons } from "../src/sim/playerSeason.js";
import { seededRng } from "../src/sim/rng.js";
import { loadAdp, type AdpFormat } from "../src/data/adp.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { simulateSeason, DEFAULT_SEASON } from "../src/model/seasonSim.js";
import { normalDraw } from "../src/sim/normal.js";
import { scoring } from "../src/scoring/active.js";
import {
  experienceBefore,
  pastShares,
  projectShares,
  SHARING_POSITIONS,
} from "../src/features/projectedShares.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { blendedPlace, leanFor, placesBy } from "../src/features/boardOrder.js";

const DOCS = join(import.meta.dirname, "..", "docs", "weekly");

/** the season being drafted for; a new one starts in March */
const CURRENT_SEASON = new Date().getUTCFullYear() -
  (new Date().getUTCMonth() < 2 ? 1 : 0);

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1]!;
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
    if (game.season !== season || game.week > 17) {
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

  /**
   * The league's keeper sheet, if one has been transcribed.
   *
   * Who a team may keep comes from last season's roster and the price
   * agreed with it, not from whoever is on the roster today: a team
   * that has cleared its squad keeps its rights. Sleeper does not
   * publish any of this, so it is a curated file and it ships with the
   * board when it exists.
   */
  const keeperSheet = await readFile(
    join(import.meta.dirname, "..", "data", "curated", `keepers${season}.csv`),
    "utf8",
  ).catch(() => "");

  if (keeperSheet) {
    const { parseCsv } = await import("../src/data/csv.js");
    const entries = parseCsv(keeperSheet).map((row) => ({
      team: row["team"] ?? "",
      player: row["player"] ?? "",
      key: normalizeName(row["player"] ?? ""),
      cost: Number(row["cost"]),
      // a consecutive keep is priced at the earlier of its round and
      // wherever the market has him this year
      marketPriced: row["consecutive"] === "1",
    }));

    await writeFile(
      join(DOCS, "data", `keepers-${season}.json`),
      JSON.stringify({ season, entries }),
    );
    console.log(`keeper sheet: ${entries.length} entries`);
  }

  const adp = await loadAdp(season, adpFormat).catch(() => new Map());

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
        modelMade: p.projectedParts
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
        bye: world.byeWeek.get(p.teamId) ?? null,
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
        weeks: (weekOpp.get(p.teamId) ?? [])
          .sort((a, b) => a.week - b.week)
          .map((g) => ({
            w: g.week,
            opp: (g.home ? "v " : "@ ") + g.opponent,
            pts: Number((p.projectedPpg * world.oppAdjust(p.position, g.opponent)).toFixed(1)),
          })),
      };
    })
    .sort((a, b) => b.vor - a.vor);

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
  const modelPlace = placesBy(board, keyOf, (p) => p.vor);
  const sharePlace = placesBy(board, keyOf, (p) => p.touches);
  const adpPlace = placesBy(board, keyOf, (p) => (p.adp === null ? null : -p.adp));
  const walkPlace = placesBy(board, keyOf, (p) => {
    const id = idOf.get(p.key);
    const says = id === undefined ? undefined : walkSays.get(id);
    return says === undefined ? null : says;
  });

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
      (p as unknown as { made: Record<string, number> }).made =
        Object.fromEntries(Object.entries(made)
          .map(([part, n]) => [part, Number((n / played).toFixed(2))]));
    }
  }

  for (const p of board) {
    (p as unknown as { blend: number }).blend = blendedPlace({
      model: modelPlace.get(p.key)!,
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
    JSON.stringify({ season, players: board }),
  );
  console.log(`board: ${board.length} players`);

  await writeFile(
    join(DOCS, "data", "index.json"),
    JSON.stringify({ weeks: index, boardSeason: season, adpFormat }),
  );
  await writeFile(
    join(DOCS, "index.html"),
    await readFile(join(import.meta.dirname, "..", "tools", "ui", "index.html"), "utf8"),
  );
  console.log(`site written to ${DOCS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

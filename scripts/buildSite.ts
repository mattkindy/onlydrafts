// Builds the static weekly site into docs/: the page plus prediction
// JSON for the requested weeks, ready for GitHub Pages.
// Run: npx tsx scripts/buildSite.ts --league <sleeper id> --weeks 10-12

import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  comingWeek, currentSeason, hasPlayerStats, loadGames, loadKickerWeeks,
  loadPlayerStats, loadTeamDefenceWeeks, loadWeeklyRosters,
} from "../src/data/nflverse.js";
import type { GameRow, PlayerWeekStats } from "../src/data/nflverse.js";
import {
  loadSleeperDefences,
  loadSleeperQuiet,
  loadSleeperWeekly,
  projectionKey,
  sleeperPointsUnder,
  withoutQuiet,
  type SleeperDefence,
  type SleeperProjection,
} from "../src/data/sleeperProjections.js";
import {
  bracketOf,
  DEFENCE_PARTS,
  drawDefenceWeeks,
  drawnQuantile,
  payDefence,
  projectDefenceWeek,
  seedOfName as seedOf,
  STANDARD_DEFENCE_PAYS,
  TRAILING_WEEKS,
  type Parts as DefenceTally,
} from "../src/features/defenceWeek.js";
import {
  weeklyExamplesForSeason,
  weeklyProspectiveForWeek,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import {
  fitWeeklyByPosition,
  predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import {
  blendPoints,
  debiasedSleeper,
  SHIPPED_BLEND_WEIGHT,
} from "../src/features/sleeperBlend.js";
import {
  componentPoints,
  historiesForWeek,
  positionRatePriors,
  blendWithComponent,
  COMPONENT_FADE_TO_WEEK,
  type History,
  type Rates,
} from "../src/features/componentWeek.js";
import { updateBoardLevels } from "../src/features/inSeasonBoard.js";
import { loadDressedWeeks } from "../src/features/dressedWeeks.js";
import { sleepersNow, type SleepersNow } from "../src/features/sleepersNow.js";
import { takePasserLines } from "../src/features/passerLine.js";
import { pointsOfLine } from "../src/features/inSeasonParts.js";
import { disagreements } from "../src/features/boardAgreement.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import {
  buildResidualModel,
  outcomeQuantile,
  type ResidualModel,
} from "../src/backtest/intervals.js";
import { normalizeName } from "../src/data/names.js";
import { parseCsv } from "../src/data/csv.js";
import { DEALT_WIDER } from "../src/features/walkWeek.js";
import { kickerParts, BANDS } from "../src/features/kickerFromWalk.js";
import { kickerSeason, type Fixture } from "../src/features/kickerSeason.js";
import {
  historyOf, loadKickerJobs, type KickerJob,
} from "../src/features/kickerJobs.js";
import {
  drawKickerWeeks,
  KICKER_PARTS,
  LEAGUE_PAID,
  payKicker,
  projectKickerWeek,
  STANDARD_KICKER_PAYS,
  TRAILING_WEEKS as KICKER_TRAILING_WEEKS,
} from "../src/features/kickerWeek.js";
import type { Venue } from "../src/features/kickingVenue.js";
import { fitClimate } from "../src/features/climate.js";
import { readingsFrom, kickoffsIn } from "../src/data/gameWeather.js";
import {
  settingLift, sharedOut, type Setting, type Weather,
} from "../src/features/weekSetting.js";
import {
  loadWeatherWeekly, weatherNote, type Forecast, type WeatherNote,
} from "../src/data/weatherWeekly.js";
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
import {
  preseasonWeekly, preseasonWeeklyExamples, preseasonWeeklyInput,
  anchorToSeason, type WeeklyProjection,
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
import {
  fitJoint, type Parts,
} from "../src/features/jointParts.js";
import type { StatParts } from "../src/features/seasonSummary.js";
import { partsIn } from "../src/data/advancedParts.js";

/**
 * The site is the site, so it goes at the top rather than down a path
 * nobody would guess. The old address still works: a page there sends
 * anyone with the link on.
 */
const DOCS = join(import.meta.dirname, "..", "docs");
const OLD = join(DOCS, "weekly");

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1]!;
}

/** how many of the terms behind a sleeper claim the board writes out */
const REASONS_KEPT = 3;

/**
 * What a player is worth against his draft price, rounded to what the
 * page shows. A player nobody counted work for has no claim, and the
 * board leaves him a null the way it does for the rest of his card.
 */
function sleeperOf(claims: SleepersNow, playerId: string) {
  const said = claims.scores.get(playerId);

  if (!said) {
    return null;
  }

  return {
    week: said.week,
    price: Math.round(said.price),
    score: Number(said.score.toFixed(1)),
    modelPpg: Number(said.modelPpg.toFixed(1)),
    pricePpg: Number(said.pricePpg.toFixed(1)),
    reasons: said.reasons.slice(0, REASONS_KEPT).map((one) => ({
      term: one.term,
      points: Number(one.points.toFixed(1)),
    })),
  };
}

/** how many seasons of weeks the component model's rate priors read */
const PRIOR_SEASONS = 8;

async function componentPriors(season: number): Promise<Map<string, Rates>> {
  const weeks: PlayerWeekStats[] = [];

  for (let s = season - PRIOR_SEASONS; s < season; s++) {
    if (!hasPlayerStats(s)) {
      continue;
    }

    weeks.push(...(await loadPlayerStats(s)));
  }

  return positionRatePriors(weeks, scoring());
}

/**
 * The component line and the season-anchored ridge line, cross faded by
 * week so the chart bends instead of jumping at a seam. A player with no
 * history behind him, or past the fade window, keeps the ridge alone.
 */
function earlyWeekLine(
  week: number,
  position: string,
  ridge: number,
  history: History | undefined,
  priors: Map<string, Rates>,
): number {
  const prior = priors.get(position);
  const points = history && prior
    ? componentPoints(history, prior, scoring())
    : undefined;

  return blendWithComponent(
    week, points !== undefined && points > 0 ? points : undefined, ridge,
  );
}

/**
 * One row a player, in the slate file the app reads. `ours` is our
 * per-position ridge and `sleeper` is Sleeper's number, null when they
 * have no row for him. A player Sleeper listed without a number is a backup
 * or a player who is out, so he gets a Sleeper 0 and an average of 0; a
 * player Sleeper never listed keeps ours alone. Otherwise `average` is the
 * two averaged, and the file is sorted by it. `floor` and
 * `ceiling` are the tenth and ninetieth of the outcome around that
 * average. `snaps` is a whole percent; `gamesMissed` is out of his last
 * four club weeks; `absenceShare` runs 0 to 1. Every point figure is
 * in the build's scoring, and `catches` says how many receptions are
 * behind them, so a league paying a catch differently can move them.
 *
 * Both the in-season slate and the preseason one below are written
 * through here, so the two files have the same shape and the app does
 * not have to know which it is reading.
 */
function slateRow(
  residuals: ResidualModel,
  e: WeeklyExample,
  ours: number,
  projection: SleeperProjection | undefined,
  quiet: boolean,
  sky?: { note: WeatherNote | undefined; lift: number },
) {
  const said = projection
    ? sleeperPointsUnder(projection, scoring().receptions)
    : quiet ? 0 : undefined;
  // his club has said he is not playing, so there is no week to project.
  // He stays on the slate with the word they used, since leaving him off
  // sent the app to his season-long game and it started him.
  const level = e.ruledOut ? 0 : ours;
  const sleeper = e.ruledOut ? 0 : said;
  // Sleeper leaves a player blank when he is not going to play, and a
  // half of our number would still rank him over players who will
  const average =
    sleeper === undefined
      ? level
      : sleeper === 0
        ? 0
        : blendPoints(
          level, debiasedSleeper(e.position, sleeper), SHIPPED_BLEND_WEIGHT);
  // a player who is not playing has no week to draw around
  const quantile = (q: number) =>
    average === 0 ? 0 : outcomeQuantile(residuals, e.position, average, q);

  return {
    name: e.playerName,
    key: normalizeName(e.playerName),
    position: e.position,
    team: e.teamId,
    opponent: (e.home ? "v " : "@ ") + e.opponent,
    ours: Number(level.toFixed(1)),
    sleeper: sleeper === undefined ? null : Number(sleeper.toFixed(1)),
    average: Number(average.toFixed(1)),
    floor: Number(quantile(0.1).toFixed(1)),
    ceiling: Number(quantile(0.9).toFixed(1)),
    q1: Number(quantile(0.25).toFixed(1)),
    q3: Number(quantile(0.75).toFixed(1)),
    catches: Number((projection?.catches ?? e.receptionsRecent).toFixed(2)),
    snaps: Math.round(e.snapRecent * 100),
    questionable: e.questionable,
    ruledOut: e.ruledOut,
    status: e.status,
    gamesMissed: e.gamesMissedRecent,
    absenceShare: Number(e.absenceShare.toFixed(2)),
    // left off a mild day entirely, which is most rows
    ...(sky?.note ? { weather: sky.note } : {}),
    ...(sky && sky.lift !== 1
      ? { weatherLift: Number(sky.lift.toFixed(3)) }
      : {}),
  };
}

type SlateRowShape = ReturnType<typeof slateRow>;

interface Slate {
  season: number;
  week: number;
  preseason: boolean;
  /** what a catch paid when the rows were scored */
  perCatch: number;
  players: SlateRowShape[];
}

/** what the line expects a side to score where a fixture has no line */
const IMPLIED_WITHOUT_A_LINE = 22.3;

/** Sleeper ranks the early weeks better than our own line does */
const SLEEPER_THROUGH_WEEK = 4;

/**
 * The last week the board's season anchor writes the slate instead of
 * the weekly ridge. scripts/earlyWeekEval.ts has the anchor ahead by
 * 0.25 points a player at week 2 and behind from week 3 on.
 */
const ANCHOR_THROUGH_WEEK = 2;

const DEFENCE_DRAWS = 2000;
const KICKER_DRAWS = 2000;

/** one defence's paid week, brackets and all */
const paidDefenceWeek = (parts: DefenceTally, allowed: number) =>
  payDefence(parts, STANDARD_DEFENCE_PAYS) +
  (STANDARD_DEFENCE_PAYS[bracketOf(allowed)] ?? 0);

/**
 * Sleeper's defence week paid under our ladder. Its own total pays a
 * return touchdown that we do not, so its parts are repaid where it
 * published them, and its total is used where it did not.
 */
function sleeperDefencePaid(said: SleeperDefence | undefined) {
  if (!said) {
    return undefined;
  }

  if (said.pointsAllowed <= 0) {
    return said.points;
  }

  return paidDefenceWeek(said.parts, said.pointsAllowed);
}

/** two defences from the slate, so a run can be read at a glance */
function sayDefenceRows(rows: SlateRowShape[]): void {
  for (const team of ["BUF", "LAC"]) {
    const row = rows.find((r) => r.position === "DEF" && r.team === team);

    if (!row) {
      console.log(`  ${team} has no defence row`);
      continue;
    }

    console.log(
      `  ${row.name} ${row.opponent}: ours ${row.ours}, ` +
      `sleeper ${row.sleeper}, blend ${row.average}, ` +
      `floor ${row.floor}, q1 ${row.q1}, q3 ${row.q3}, ` +
      `ceiling ${row.ceiling}`,
    );
  }
}

/**
 * A defence's row in the slate, the same shape as a skill player's.
 *
 * `ours` is the weekly defence line: the defence's own recent weeks,
 * the sacks the other side gives up and what the line expects that side
 * to score. `sleeper` is Sleeper's parts paid under the same ladder.
 * Through week four Sleeper ranks defences better than our line does,
 * so the blend takes its number there and ours from week five, which is
 * what the defence bench found.
 *
 * The floor and the ceiling come from drawing the week off the parts,
 * the way the start/sit view draws the board's defence, rather than off
 * the skill-position residuals, which know nothing about brackets.
 */
async function defenceSlateRows(
  season: number, week: number, games: GameRow[],
): Promise<SlateRowShape[]> {
  const sleeperDefences = await loadSleeperDefences();
  const played = (await loadTeamDefenceWeeks(season))
    .filter((w) => w.week < week);
  const lastSeason = await loadTeamDefenceWeeks(season - 1);
  const allowed = new Map<string, number>();
  const implied = new Map<string, number>();
  const fixtures: { team: string; against: string; home: boolean }[] = [];

  for (const g of games) {
    const at = (team: string) => `${g.season}|${g.week}|${team}`;

    if (g.homeScore !== undefined && g.awayScore !== undefined) {
      allowed.set(at(g.homeTeamId), g.awayScore);
      allowed.set(at(g.awayTeamId), g.homeScore);
    }

    if (g.totalLine !== undefined && g.spreadLine !== undefined) {
      implied.set(at(g.homeTeamId), g.totalLine / 2 - g.spreadLine / 2);
      implied.set(at(g.awayTeamId), g.totalLine / 2 + g.spreadLine / 2);
    }

    if (g.season === season && g.week === week) {
      fixtures.push(
        { team: g.homeTeamId, against: g.awayTeamId, home: true },
        { team: g.awayTeamId, against: g.homeTeamId, home: false },
      );
    }
  }

  /** what each side has given up in sacks a game, this season or last */
  const sacksAllowed = new Map<string, number>();
  const tally = new Map<string, { sacks: number; games: number }>();

  for (const w of played.length ? played : lastSeason) {
    const so = tally.get(w.opponentId) ?? { sacks: 0, games: 0 };
    so.sacks += w.parts["sack"] ?? 0;
    so.games++;
    tally.set(w.opponentId, so);
  }

  for (const [team, so] of tally) {
    sacksAllowed.set(team, so.sacks / so.games);
  }

  /** each defence's own weeks, oldest first, and last season's average */
  const ownWeeks = new Map<string, { paid: number; parts: DefenceTally }[]>();

  for (const w of [...played].sort((a, b) => a.week - b.week)) {
    const gave = allowed.get(`${season}|${w.week}|${w.teamId}`);

    if (gave === undefined) {
      continue;
    }

    ownWeeks.set(w.teamId, [
      ...(ownWeeks.get(w.teamId) ?? []),
      { paid: paidDefenceWeek(w.parts, gave), parts: w.parts },
    ]);
  }

  const lastYear = new Map<string, number>();
  const lastYearGames = new Map<string, { paid: number; games: number }>();

  for (const w of lastSeason) {
    const gave = allowed.get(`${season - 1}|${w.week}|${w.teamId}`);

    if (gave === undefined) {
      continue;
    }

    const so = lastYearGames.get(w.teamId) ?? { paid: 0, games: 0 };
    so.paid += paidDefenceWeek(w.parts, gave);
    so.games++;
    lastYearGames.set(w.teamId, so);
  }

  for (const [team, so] of lastYearGames) {
    lastYear.set(team, so.paid / so.games);
  }

  return fixtures.map(({ team, against, home }) => {
    const own = (ownWeeks.get(team) ?? []).slice(-TRAILING_WEEKS);
    const line = projectDefenceWeek({
      ownPaid: (ownWeeks.get(team) ?? []).map((w) => w.paid),
      lastYearPaid: lastYear.get(team) ?? 7,
      ownParts: Object.fromEntries(DEFENCE_PARTS.map((part) => [
        part,
        own.reduce((sum, w) => sum + (w.parts[part] ?? 0), 0) /
          Math.max(1, own.length),
      ])),
      ownGames: own.length,
      oppSacksAllowed: sacksAllowed.get(against) ?? 2.37,
      impliedAgainst: implied.get(`${season}|${week}|${team}`) ??
        IMPLIED_WITHOUT_A_LINE,
    });
    const sleeper = sleeperDefencePaid(
      sleeperDefences.get(projectionKey(season, week, team)),
    );
    const average = week <= SLEEPER_THROUGH_WEEK && sleeper !== undefined
      ? sleeper
      : line.paid;
    // the spread comes off our parts either way, centred on the blend
    const shift = average - line.paid;
    const weeks = drawDefenceWeeks(
      line.parts, STANDARD_DEFENCE_PAYS, seedOf(team), DEFENCE_DRAWS,
    ).map((n) => n + shift);
    const at = (q: number) => Number(drawnQuantile(weeks, q).toFixed(1));

    return {
      name: team,
      key: normalizeName(team),
      position: "DEF",
      team,
      opponent: (home ? "v " : "@ ") + against,
      ours: Number(line.paid.toFixed(1)),
      sleeper: sleeper === undefined ? null : Number(sleeper.toFixed(1)),
      average: Number(average.toFixed(1)),
      floor: at(0.1),
      ceiling: at(0.9),
      q1: at(0.25),
      q3: at(0.75),
      catches: 0,
      snaps: 100,
      questionable: false,
      ruledOut: false,
      status: "",
      gamesMissed: 0,
      absenceShare: 0,
    };
  });
}

/**
 * The weather a fixture is likely to be played in: the forecast where
 * anyone has one, and otherwise what that ground usually gets in that
 * week. Built once and kept, since the climate fit reads every game
 * ever played.
 */
let weatherAhead: Promise<{
  forecast: Map<string, Forecast>;
  usually: { temperature: (g: GameRow) => number; wind: (g: GameRow) => number };
}> | undefined;

function weatherFor(season: number) {
  weatherAhead ??= (async () => {
    const rows = (await loadWeatherWeekly()).filter((f) => f.season === season);
    const gameRows = parseCsv(await readFile(
      join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
    const climate = fitClimate(readingsFrom(gameRows));

    return {
      forecast: new Map(rows.map((f) => [`${f.homeTeam}|${f.week}`, f])),
      usually: {
        temperature: (g: GameRow) =>
          climate.meanTemperature(g.homeTeamId, g.week, g.hour ?? 13),
        wind: (g: GameRow) => climate.meanWind(g.homeTeamId),
      },
    };
  })();

  return weatherAhead;
}

/** two kickers from the slate, so a run can be read at a glance */
function sayKickerRows(rows: SlateRowShape[]): void {
  for (const row of rows.filter((r) => r.position === "K").slice(0, 2)) {
    console.log(
      `  ${row.name} ${row.team} ${row.opponent}: ours ${row.ours}, ` +
      `floor ${row.floor}, ceiling ${row.ceiling}`,
    );
  }
}

/**
 * A kicker's row in the slate, the same shape as a defence's.
 *
 * Almost nothing about a kicker's week can be told in advance. The
 * kickerWeekEval bench puts this line at 0.08 correlation with what he
 * goes on to kick, against 0.00 for calling every kicker average, so it
 * barely orders them. It replaces the flat eight point week the
 * start/sit view fell back on, which named no fixture and drew the same
 * floor and ceiling for everybody.
 *
 * Sleeper is left null: the projections fetch asks for the skill
 * positions and the defences, and never for kickers.
 */
async function kickerSlateRows(
  season: number, week: number, games: GameRow[],
): Promise<SlateRowShape[]> {
  const jobs = await loadKickerJobs(season, week);
  const { forecast, usually } = await weatherFor(season);
  const soFar = (await loadKickerWeeks(season)).filter((w) => w.week < week);
  const ownWeeks = new Map<string, typeof soFar>();

  for (const w of [...soFar].sort((a, b) => a.week - b.week)) {
    ownWeeks.set(w.playerId, [...(ownWeeks.get(w.playerId) ?? []), w]);
  }

  const fixtures = new Map<string, {
    against: string; home: boolean; implied: number; venue: Venue;
    note: WeatherNote | undefined;
  }>();

  for (const g of games) {
    if (g.season !== season || g.week !== week) {
      continue;
    }

    // nflverse fills temp and wind in after a game, so a fixture that
    // has not kicked off has neither and every outdoor kicker used to
    // be priced at a mild still 60 and 6
    const said = forecast.get(`${g.homeTeamId}|${g.week}`);
    const venue: Venue = g.indoors ? { indoors: true } : {
      indoors: false,
      temperature: g.temp ?? said?.temperature ?? usually.temperature(g),
      wind: g.wind ?? said?.wind ?? usually.wind(g),
      precipitation: said?.precipitation,
    };
    const half = (g.totalLine ?? 0) / 2;
    const tilt = (g.spreadLine ?? 0) / 2;
    const known = g.totalLine !== undefined && g.spreadLine !== undefined;

    const note = g.indoors ? undefined : weatherNote(said);

    fixtures.set(g.homeTeamId, {
      against: g.awayTeamId,
      home: true,
      implied: known ? half - tilt : IMPLIED_WITHOUT_A_LINE,
      venue,
      note,
    });
    fixtures.set(g.awayTeamId, {
      against: g.homeTeamId,
      home: false,
      implied: known ? half + tilt : IMPLIED_WITHOUT_A_LINE,
      venue,
      note,
    });
  }

  const rowFor = (job: KickerJob): SlateRowShape[] => {
    const fixture = fixtures.get(job.team);

    if (!fixture) {
      return [];
    }

    const own = (ownWeeks.get(job.record.playerId) ?? [])
      .slice(-KICKER_TRAILING_WEEKS);
    const lastYear = job.record.games > 0
      ? payKicker(job.record.parts, STANDARD_KICKER_PAYS) / job.record.games
      : LEAGUE_PAID;
    const line = projectKickerWeek({
      ownPaid: own.map((w) => payKicker(w.parts, STANDARD_KICKER_PAYS)),
      lastYearPaid: lastYear,
      ownParts: Object.fromEntries(KICKER_PARTS.map((part) => [
        part,
        own.reduce((sum, w) => sum + (w.parts[part] ?? 0), 0) /
          Math.max(1, own.length),
      ])),
      ownGames: own.length,
      impliedFor: fixture.implied,
      venue: fixture.venue,
    });
    const key = normalizeName(job.record.name);
    const weeks = drawKickerWeeks(
      line.parts, STANDARD_KICKER_PAYS, seedOf(key), KICKER_DRAWS,
    );
    const at = (q: number) => Number(drawnQuantile(weeks, q).toFixed(1));

    return [{
      name: job.record.name,
      key,
      position: "K",
      team: job.team,
      opponent: (fixture.home ? "v " : "@ ") + fixture.against,
      ours: Number(line.paid.toFixed(1)),
      sleeper: null,
      average: Number(line.paid.toFixed(1)),
      floor: at(0.1),
      ceiling: at(0.9),
      q1: at(0.25),
      q3: at(0.75),
      catches: 0,
      snaps: 100,
      questionable: false,
      ruledOut: false,
      status: "",
      gamesMissed: 0,
      absenceShare: 0,
      ...(fixture.note ? { weather: fixture.note } : {}),
    }];
  };

  return [...jobs.values()].flatMap(rowFor);
}

/** what the slate file says about itself, or nothing if it is unreadable */
function slateThere(text: string): { preseason?: boolean } {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Writes a week's slate, unless the one already there was built from
 * played games and this one comes from the preseason path. A season
 * whose weekly stats nflverse has not published yet builds a preseason
 * slate, and a scheduled refresh that runs before the release lands
 * would otherwise turn a played week's numbers back into projections.
 */
async function writeSlate(path: string, slate: Slate): Promise<void> {
  const there = slateThere(await readFile(path, "utf8").catch(() => ""));

  if (slate.preseason && there.preseason === false) {
    console.log(
      `week ${slate.week} already has a slate from played games, so the ` +
        "preseason one is not written",
    );
    return;
  }

  await writeFile(path, JSON.stringify(slate));
  const from = slate.preseason ? " from the preseason path" : "";
  console.log(`week ${slate.week}${from}: ${slate.players.length} players`);
}

/**
 * Each player's place by one model over the parts of his play. A player the
 * advanced stat files have never seen is left out rather than guessed
 * at, and the blend gives his weight to the opinions that do have
 * something, which is how a rookie is handled.
 */
async function partsSays<T extends { position: string }>(
  board: T[],
  keyOf: (player: T) => string,
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

  for (const player of board) {
    const id = idOf.get(keyOf(player));
    const his = id === undefined ? undefined : lastYear.get(id);

    if (his) {
      said.set(keyOf(player), fitted.says(his, player.position));
    }
  }

  /**
   * A rookie has no parts, and he has a draft slot, which orders first
   * seasons at 0.607 on its own. His slot's expected points fill the
   * slot, fitted on the rookies of the seasons this build may see, so
   * the parts opinion stops being silent about exactly the players the
   * market prices well.
   */
  const slotRows: number[][] = [];
  const slotPpg: number[] = [];
  const earlier = await loadDraftPicks(
    Array.from({ length: 7 }, (_, i) => season - 1 - i),
  );
  const columnsAt = (pick: number, position: string) => [
    1, Math.log(pick) / Math.log(260),
    position === "RB" ? 1 : 0, position === "WR" ? 1 : 0,
    position === "QB" ? 1 : 0,
  ];
  const outcomes = new Map<string, { points: number; games: number }>();

  for (let year = season - 7; year < season; year++) {
    for (const s of await loadPlayerStats(year).catch(() => [])) {
      if (s.week > 18) {
        continue;
      }

      const so = outcomes.get(`${year}|${s.playerId}`) ?? { points: 0, games: 0 };
      so.points += fantasyPoints(s.statLine, scoring());
      so.games++;
      outcomes.set(`${year}|${s.playerId}`, so);
    }
  }

  for (const p of earlier.values()) {
    const his = outcomes.get(`${p.season}|${p.playerId}`);

    if (!his || his.games < 4) {
      continue;
    }

    slotRows.push(columnsAt(p.pick, p.position));
    slotPpg.push(his.points / his.games);
  }

  const slotFit = slotRows.length >= 60
    ? fitRidge(slotRows, slotPpg, 0.5)
    : undefined;
  const draftClass = await loadDraftPicks([season]);
  let slotted = 0;

  if (slotFit) {
    for (const player of board) {
      const id = idOf.get(keyOf(player));

      if (said.has(keyOf(player)) || id === undefined) {
        continue;
      }

      const pick = draftClass.get(id) ??
        [...draftClass.values()].find((p) => p.playerId === id);

      if (!pick || pick.season !== season) {
        continue;
      }

      said.set(
        keyOf(player),
        Math.max(0, predictRidge(slotFit, columnsAt(pick.pick, pick.position))),
      );
      slotted++;
    }
  }

  console.log(
    `his parts speak for ${said.size} of ${board.length} on the board, ` +
    `taught on ${learn.length} seasons of players, ${slotted} rookies at their slot`,
  );

  return placesBy(
    board.filter((player) => said.has(keyOf(player))), keyOf,
    (player) => said.get(keyOf(player)) ?? null,
  );
}

/**
 * Vite cannot empty docs first, since the data lives there too, so a
 * scheduled build would collect a stale bundle a week forever.
 */
/**
 * Everything the page still reaches, following one asset to the next.
 *
 * The page points at the entry chunk and the entry chunk points at the
 * worker, so checking the page alone deleted the worker on every build.
 */
async function assetsInUse(names: string[]): Promise<Set<string>> {
  const dir = join(DOCS, "assets");
  const page = await readFile(join(DOCS, "index.html"), "utf8");
  const live = new Set(names.filter((name) => page.includes(name)));
  const toRead = [...live];

  while (toRead.length) {
    const name = toRead.pop()!;
    const text = await readFile(join(dir, name), "utf8").catch(() => "");

    for (const other of names) {
      if (!live.has(other) && text.includes(other)) {
        live.add(other);
        toRead.push(other);
      }
    }
  }

  return live;
}

async function dropStaleAssets(): Promise<void> {
  const dir = join(DOCS, "assets");
  const names = await readdir(dir).catch(() => []);
  const live = await assetsInUse(names);

  for (const name of names) {
    if (live.has(name)) {
      continue;
    }

    await rm(join(dir, name));
    console.log(`dropped the old ${name}`);
  }
}

async function main(): Promise<void> {
  const season = Number(argOf("--season", String(currentSeason())));
  const leagueId = argOf("--league", "");
  const format = argOf("--scoring", "");
  // The draft board has to match the draft. A point a catch moves
  // receivers up the order, so a standard league needs the standard
  // mocks or every alternative it prices is the wrong player.
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
  const games = await loadGames();
  const asked = weeksArg === ""
    ? [comingWeek(games, season)]
    : range
    ? Array.from(
        { length: Number(range[2]) - Number(range[1]) + 1 },
        (_, i) => Number(range[1]) + i,
      )
      : weeksArg.split(",").map(Number);

  // Nobody has played a game this season, so there is no recent form to
  // read and nothing to walk. The preseason path writes the slate below.
  const weeks = hasPlayerStats(season) ? asked : [];

  if (weeks.length === 0) {
    console.log(
      `no weekly stats for ${season} on disk, so week ${asked[0]} comes ` +
        "from the preseason path",
    );
  }

  const train: WeeklyExample[] = [];

  for (let s = 2016; s < season; s++) {
    train.push(...(await weeklyExamplesForSeason(s, games)));
  }

  const weekly = fitWeeklyByPosition(train);
  const residuals = buildResidualModel(
    train.map((e) => ({
      position: e.position,
      predicted: predictWeeklyByPosition(weekly, e),
      actual: e.target,
    })),
    5,
  );
  const quiet = await loadSleeperQuiet();
  const projections = withoutQuiet(await loadSleeperWeekly(), quiet);

  await mkdir(join(DOCS, "data"), { recursive: true });

  const index: { season: number; week: number }[] = [];

  /**
   * Our own line for each week a slate was written, by player, so the
   * board's card and the slate a lineup is set against say the same
   * thing about the same week.
   */
  const slateLine = new Map<number, Map<string, number>>();
  const priors = await componentPriors(season);
  const prevStats = await loadPlayerStats(season - 1);
  const thisSeason = hasPlayerStats(season)
    ? await loadPlayerStats(season)
    : [];
  // What he actually did in a week already played, in the same
  // categories `projected` uses, so a reader's league scores it by its
  // own rules. A stat he did not touch is left out rather than zero.
  const playedByPlayer = new Map<string, Map<number, Record<string, number>>>();

  for (const s of thisSeason) {
    const parts = Object.fromEntries(
      Object.entries(s.statLine).filter(([, n]) => n !== 0)
        .map(([stat, n]) => [stat, Number(n.toFixed(2))]),
    );
    const byWeek = playedByPlayer.get(s.playerId) ?? new Map();

    byWeek.set(s.week, parts);
    playedByPlayer.set(s.playerId, byWeek);
  }

  // A man who dressed and never touched the ball played that game and
  // scored nothing, which the card should say rather than leaving his
  // week blank the way it does for one nobody has played yet.
  for (const dressed of await loadDressedWeeks(season, thisSeason)) {
    const byWeek = playedByPlayer.get(dressed.playerId) ?? new Map();

    if (byWeek.has(dressed.week)) {
      continue;
    }

    byWeek.set(dressed.week, {});
    playedByPlayer.set(dressed.playerId, byWeek);
  }
  /**
   * What each player had behind him going into each week the component
   * line still counts for something. Before a season is played that is
   * his previous one alone.
   */
  const earlyHistories = new Map<number, Map<string, History>>();

  for (let w = 1; w < COMPONENT_FADE_TO_WEEK; w++) {
    earlyHistories.set(
      w, historiesForWeek(thisSeason, prevStats, w, scoring()));
  }

  // season draft board with replacement value, for the draft view
  const world = await buildPreseasonWorld(season);
  console.log(
    `${await takePasserLines(world.players, season)} passers take the joint line`,
  );
  // what the season has shown so far moves the level everything else is
  // worked out from, so it has to land before anybody reads it, and the
  // slate below is one of the readers
  await updateBoardLevels(world.players, season);

  const { projectDraftExamples } = await import("../src/features/seasonModel.js");
  const draftExamples = await projectDraftExamples(season, world.data);
  const exampleById = new Map(draftExamples.map((e) => [e.playerId, e]));

  // where and when each fixture is played, so a kicker's week can be a
  // freezing night in Buffalo rather than another mild afternoon
  const gameRows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
  const whereEach = new Map<string, Setting>();
  const skyAtGround = (await weatherFor(season)).forecast;
  /** both sides play at the home ground, so a club week resolves to one row */
  const skyForClub = new Map<string, Forecast>();

  for (const k of kickoffsIn(gameRows, season)) {
    const indoors = k.indoors;
    // both sides play at the home ground, so one forecast covers them
    const weather = skyAtGround.get(`${k.homeTeam}|${k.week}`);

    for (const [team, rest] of [
      [k.homeTeam, k.homeRest], [k.awayTeam, k.awayRest],
    ] as [string, number][]) {
      whereEach.set(`${team}|${k.week}`, {
        indoors, night: k.hour >= 18, restDays: rest, weather,
      });

      if (weather && !indoors) {
        skyForClub.set(`${team}|${k.week}`, weather);
      }
    }
  }

  const forecastFor = (team: string, week: number) =>
    skyForClub.get(`${team}|${week}`);

  const settingOf = (team: string, week: number): Setting =>
    whereEach.get(`${team}|${week}`) ??
      { indoors: false, night: false, restDays: 7 };

  /**
   * The forecast only reaches the weeks in front of us, and sharedOut
   * divides by the mean, so a single wet week in a season chart would
   * quietly raise all sixteen others. The season chart takes the roof
   * and the kickoff time; the slate below takes the weather.
   */
  const seasonSettingOf = (team: string, week: number): Setting => {
    const { weather: _ignored, ...rest } = settingOf(team, week);

    return rest;
  };

  /** his targets over his touches, which decides how the wind treats a back */
  const catchShareOf = (e: WeeklyExample): number => {
    const touches = e.targetsRecent + e.carriesRecent;

    return touches > 0 ? e.targetsRecent / touches : 0;
  };

  const saidInput = await preseasonWeeklyInput(world, exampleById);
  const saidWeekly = preseasonWeekly(saidInput);

  /**
   * Each player's season shaped over his fixtures and then rescaled so
   * it averages the level the season so far has moved him to. This is
   * the board's own week chart, and week 2 of the slate is read off it.
   */
  const anchoredWeeks = new Map<string, WeeklyProjection[]>();

  for (const p of world.players) {
    const his = saidWeekly.get(p.playerId);

    if (!his) {
      continue;
    }

    /**
     * The roof, the kickoff time and the short week, and nothing else.
     *
     * Game script was in here and it is out again. It is a true thing
     * about football, and the part of it that survives to August does
     * not predict a week: against 2025 it went with what happened at
     * -0.004, and it dragged the roof from 0.050 down to 0.038.
     */
    const lifts = sharedOut(his.map((w) =>
      settingLift(p.position, seasonSettingOf(p.teamId, w.week))));
    const lifted = his.map((w, i) => ({ ...w, points: w.points * lifts[i]! }));

    anchoredWeeks.set(p.playerId, anchorToSeason(lifted, p.projectedPpg));
  }

  /**
   * Week 2 is where the weekly ridge is worst: it reads one box score
   * through coefficients learned on four game means, and the board's
   * anchor beats it there by a quarter of a point a player. From week 3
   * the ridge is ahead again. A player the board has no level for keeps
   * the ridge whatever the week.
   */
  const slateLineFor = (week: number, e: WeeklyExample): number => {
    const ridge = predictWeeklyByPosition(weekly, e);

    if (week > ANCHOR_THROUGH_WEEK) {
      return ridge;
    }

    const anchored = anchoredWeeks.get(e.playerId)
      ?.find((w) => w.week === week);

    return anchored ? anchored.points : ridge;
  };

  for (const week of weeks) {
    const histories = earlyHistories.get(week) ?? new Map<string, History>();
    const ours = new Map<string, number>();
    const players = (await weeklyProspectiveForWeek(season, week, games))
      .map((e) => {
        const said = earlyWeekLine(
          week,
          e.position,
          slateLineFor(week, e),
          histories.get(e.playerId),
          priors,
        );
        // the roof and the kickoff time are already in the line through
        // the season chart, so only the forecast is left to apply
        const sky = settingOf(e.teamId, week).weather;
        const lift = sky
          ? settingLift(
            e.position,
            { indoors: false, night: false, restDays: 7, weather: sky },
            catchShareOf(e),
          )
          : 1;
        const line = said * lift;

        // his card says what the slate says, and the slate has him at zero
        ours.set(e.playerId, e.ruledOut ? 0 : line);

        return slateRow(
          residuals,
          e,
          line,
          projections.get(projectionKey(season, week, e.playerId)),
          quiet.has(projectionKey(season, week, e.playerId)),
          { note: weatherNote(forecastFor(e.teamId, week)), lift },
        );
      });

    slateLine.set(week, ours);
    const rows = [
      ...players,
      ...(await defenceSlateRows(season, week, games)),
      ...(await kickerSlateRows(season, week, games)),
    ].sort((a, b) => b.average - a.average);

    await writeSlate(
      join(DOCS, "data", `slate-${season}-${week}.json`),
      {
        season, week, preseason: false, perCatch: scoring().receptions,
        players: rows,
      },
    );
    sayDefenceRows(rows);
    sayKickerRows(rows);
    index.push({ season, week });
  }

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
    const sleeperAdp = await loadSleeperAdp(season, named).catch(() => new Map());

    for (const key of new Set([...sleeperAdp.keys(), ...mocks.keys()])) {
      const his = sleeperAdp.get(key);
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
   * How much of his offence each player is projected to touch.
   *
   * The regression asks what a player did and what has changed around
   * him. This asks a different question: of the work his position
   * group has to give out, how much does he win against the players he is
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

    for (const player of roster) {
      const share = shares.get(player.playerId);

      if (share !== undefined) {
        touchesFor.set(
          player.playerId, share * (ranPlays.get(`${season - 1}|${player.team}`) ?? 1000),
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
   * player's simulated spread is scaled to sit around his projection.
   */
  const shapeOf = new Map<
    string, { q1: number; mid: number; q3: number; low: number; high: number }
  >();

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
      // No role drift: the card's middle half is about his weeks in the
      // role he has, not our doubt about the role. Pooling role draws
      // made a receiver's middle half twice as wide as it really is.
      const simulated = simulateSeason(
        { plays: playsByTeam.get(team)! }, roster,
        { ...DEFAULT_SEASON, runs: 400, roleDrift: 0, scoring: scoring() }, draws,
      );

      for (const player of simulated) {
        const mean = player.weekly.mean;

        if (mean <= 0) {
          continue;
        }

        // as a share of his own mean, since the projection it is hung
        // on is a mean; a thin player's median can be a tenth of his mean
        shapeOf.set(player.playerId, {
          q1: player.weekly.p25 / mean,
          mid: player.weekly.median / mean,
          q3: player.weekly.p75 / mean,
          low: player.weekly.p10 / mean,
          high: player.weekly.p90 / mean,
        });
      }
    }

    console.log(`shapes from the simulation for ${shapeOf.size} players`);
  } catch (error) {
    console.warn("no simulated shapes, falling back to the pooled bands: " + error);
  }

  /**
   * The walk's own spread wins over the role simulation's wherever
   * the walk has dealt a player enough games: the kept season file
   * records every game he was handed, so his band is his, from the
   * same engine that made his projection. The role simulation stays
   * for the players the walk never played.
   */
  const dealtGames = new Map<string, number[]>();

  try {
    const keptGames = JSON.parse(await readFile(
      join(import.meta.dirname, "..", "data", "kept", `played-${season}.json`),
      "utf8",
    )) as { samples?: [string, number[]][] };
    let fromWalk = 0;
    const WIDER = DEALT_WIDER;

    for (const [playerId, his] of keptGames.samples ?? []) {
      dealtGames.set(playerId, his);

      if (his.length < 40) {
        continue;
      }

      const sorted = [...his].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.floor(q * (sorted.length - 1))]!;
      const middle = at(0.5);
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;

      if (mean <= 0) {
        continue;
      }

      const stretched = (q: number) =>
        Math.max(0, middle + (at(q) - middle) * WIDER) / mean;
      shapeOf.set(playerId, {
        q1: stretched(0.25), mid: stretched(0.5), q3: stretched(0.75),
        low: stretched(0.1), high: stretched(0.9),
      });
      fromWalk++;
    }

    console.log(`spreads from the walk's games for ${fromWalk} players`);
  } catch {
    console.warn("no kept walk games, the role simulation's bands remain");
  }

  /**
   * Each player's weeks from the weekly model rather than from his
   * season average times a blunted opponent. The two order a week
   * about equally well, but this one is the model that was measured,
   * and it says what it thinks of a matchup rather than what a
   * constant chosen by hand says.
   */
  const weeklyByPlayer = new Map<string, WeeklyProjection[]>();

  for (const p of world.players) {
    const anchored = anchoredWeeks.get(p.playerId);

    if (!anchored) {
      continue;
    }

    /**
     * The early weeks lean on his usage and his rates instead of his
     * season anchor, fading out as the season anchor takes over, since
     * so early there is almost nothing of this season for it to stand
     * on yet.
     */
    const shape = anchored.map((w) => ({
      ...w,
      points: earlyWeekLine(
        w.week,
        p.position,
        w.points,
        earlyHistories.get(w.week)?.get(p.playerId),
        priors,
      ),
    }));

    /**
     * A week a slate covers takes the slate's own number.
     *
     * The board used to mix the live walk into the one week it had
     * walked and leave the other sixteen on the season shape, so
     * Jeremiyah Love's card read 26.3 for week 2 against 16.6 for his
     * season and 10.4 on the slate a lineup is set against.
     */
    weeklyByPlayer.set(
      p.playerId,
      shape.map((w) => {
        const said = slateLine.get(w.week)?.get(p.playerId);

        // the slate lets a fringe player go under zero, and a week on
        // the card is a multiple of his own average, which does not
        return said === undefined ? w : { ...w, points: Math.max(0, said) };
      }),
    );
  }

  /**
   * The coming week from the preseason path, for a season nobody has
   * played yet. It is the same file the in-season slate writes, with
   * `preseason` set so the app can say where the numbers came from.
   * Only the one week is written: a slate is what you set a lineup
   * against, and past week 1 nflverse has published weekly stats.
   */
  if (weeks.length === 0) {
    const week = asked[0]!;
    const saidExamples = preseasonWeeklyExamples(saidInput);
    const players = world.players
      .filter((p) => ["QB", "RB", "WR", "TE"].includes(p.position))
      .flatMap((p) => {
        const row = saidExamples.get(p.playerId)?.find((e) => e.week === week);
        const ours = weeklyByPlayer.get(p.playerId)
          ?.find((w) => w.week === week)?.points;

        if (!row || ours === undefined) {
          return [];
        }

        return [slateRow(
          residuals,
          row,
          ours,
          projections.get(projectionKey(season, week, p.playerId)),
          quiet.has(projectionKey(season, week, p.playerId)),
        )];
      });
    const rows = [
      ...players,
      ...(await defenceSlateRows(season, week, games)),
      ...(await kickerSlateRows(season, week, games)),
    ].sort((a, b) => b.average - a.average);

    await writeSlate(
      join(DOCS, "data", `slate-${season}-${week}.json`),
      {
        season, week, preseason: true, perCatch: scoring().receptions,
        players: rows,
      },
    );
    sayDefenceRows(rows);
    sayKickerRows(rows);
    index.push({ season, week });
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
    dealtGames,
  );
  const simById = new Map(sims.map((s) => [s.playerId, s]));
  // the last week everybody has finished, since a week half played
  // would read a Thursday night game as a whole round of them
  const claims = await sleepersNow(
    season, comingWeek(games, season) - 1, games,
  );

  if (claims.skipped) {
    console.log(`no sleeper scores on the board: ${claims.skipped}`);
  } else {
    console.log(`sleeper scores: ${claims.scores.size} players`);
  }

  /**
   * The line a week ahead would get if a slate were written for it: our
   * week times Sleeper's, the same blend the slate uses. Sleeper publishes
   * every week of the season and revises it as the week nears, so a card
   * reading a week in November has something more than our schedule
   * factor behind it. A week Sleeper has no row for gets nothing.
   *
   * A week a slate already covers is skipped, because its `of` was built
   * from the slate line and blending that again would count Sleeper twice.
   */
  const weekAhead = comingWeek(games, season);
  const blendAhead = (p: { playerId: string; position: string }, week: number,
                      ours: number) => {
    const said = projections.get(projectionKey(season, week, p.playerId));

    if (week < weekAhead || slateLine.get(week)?.has(p.playerId) || !said) {
      return {};
    }

    const sleeper = sleeperPointsUnder(said, scoring().receptions);

    return {
      blend: Number(blendPoints(
        ours, debiasedSleeper(p.position, sleeper), SHIPPED_BLEND_WEIGHT,
      ).toFixed(1)),
      catches: Number((said.catches ?? 0).toFixed(2)),
    };
  };

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
        sleeper: sleeperOf(claims, p.playerId),
        game: {
          ev: Number(p.projectedPpg.toFixed(1)),
          q1: perGame(0.25, shape?.q1),
          mid: perGame(0.5, shape?.mid),
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
        // A multiple of his own average, since points here would be
        // points under one league's scoring. A player projected at
        // nothing has no average, so a flat one beats zero everywhere.
        weeks: (weeklyByPlayer.get(p.playerId) ?? [])
          .map((w) => {
            const of = p.projectedPpg >= 1
              ? Number((w.points / p.projectedPpg).toFixed(3))
              : 1;

            return {
              w: w.week,
              opp: (w.home ? "v " : "@ ") + w.opponent,
              of,
              played: playedByPlayer.get(p.playerId)?.get(w.week) ?? null,
              ...blendAhead(p, w.week, of * p.projectedPpg),
            };
          }),
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
  const defended = new Map<string, { parts: Tally }>();
  const num = (row: Record<string, string | undefined>, key: string) =>
    Number(row[key] ?? 0) || 0;

  /**
   * Who is on each defence this year, so last season's work follows
   * the player rather than the shirt. A club that lost its pass rush
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
    // def_fumbles is a defender losing his own, a tenth of a game. What
    // a defence is paid for is recovering the other side's.
    add("fum_rec", num(row, "fumble_recovery_opp"));
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
   * What a kicker who keeps the job plays. Three seasons of them come
   * out at a shade over fifteen, and giving him a full seventeen while
   * every skill player is cut to his own availability made a kicker's
   * season look worth more than it is.
   *
   * The kickerSeasonEval bench found nothing in the spring that picks
   * out the kicker who will lose the job: last season's accuracy moves
   * games played by a game and a bit, so one number for all of them is
   * as good as it gets. What did matter was leaving out the kicker
   * nobody has signed, which the job read now does.
   */
  const KICKER_GAMES = 15.3;
  // read through the coming week, so a kicker who lost the job in
  // September stops being the club's kicker on the board too
  const kickerJobs = await loadKickerJobs(season, comingWeek(games, season));
  /** what he has already kicked this season, by week, for his card */
  const kickedThisSeason = new Map<string, Map<number, Record<string, number>>>();

  for (const w of await loadKickerWeeks(season)) {
    const byWeek = kickedThisSeason.get(w.playerId) ?? new Map();
    byWeek.set(w.week, Object.fromEntries(
      Object.entries(w.parts).filter(([, n]) => n !== 0)));
    kickedThisSeason.set(w.playerId, byWeek);
  }

  for (const job of kickerJobs.values()) {
    const his = job.record;

    const key = normalizeName(his.name);
    const its = kicksOf.get(job.team);

    // with no walk behind his club and no season behind him there is
    // nothing to put on a card
    if (!its && his.games === 0) {
      continue;
    }

    const asHim = historyOf(his);
    // his season played out game by game, so his card gets a spread and
    // a season total like anybody else's
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
          (fixturesFor.get(job.team) ?? []).sort((a, b) => a.week - b.week),
          climate,
        )
      : null;
    const asKicked = its
      ? kickerParts(
          asHim,
          its.from.map((yardline) => yardline + 17),
          its.conversions * walkRuns,
          runsOver,
        )
      : null;
    // a kicker in his first season has no last year to show
    const perGame = his.games > 0
      ? Object.fromEntries(Object.entries(his.parts)
          .map(([part, n]) => [part, Number((n / his.games).toFixed(3))]))
      : null;

    others.push({
      name: his.name, key, position: "K", team: job.team,
      // what the walk hands him, with what he did last season beside it
      simulated: walked?.parts ?? asKicked ?? perGame,
      game: walked?.game ?? null,
      sim: walked?.sim ?? null,
      weeks: (weekOpp.get(job.team) ?? []).map((w) => ({
        w: w.week,
        opp: (w.home ? "v " : "@ ") + w.opponent,
        of: walked?.byWeek.find((b) => b.w === w.week)?.of ?? 1,
        played: kickedThisSeason.get(his.playerId)?.get(w.week) ?? null,
      })),
      lastYear: perGame,
      fromWalk: Boolean(asKicked),
      adpBy: adpBoth.get(`${key}|K`) ?? null,
      bye: world.byeWeek.get(job.team) ?? null,
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
    // a season's work from the players who play there now, over a season
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
   * players keep their weight with the other opinions, the way every
   * silent opinion is treated.
   */
  const playedFile = await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${season}.json`),
    "utf8",
  ).catch(() => "");
  const played = playedFile
    ? JSON.parse(playedFile) as {
        runs?: number;
        total: [string, number][];
        games: [string, number][];
        made?: [string, Record<string, number>][];
        samples?: [string, number[]][];
      }
    : { total: [], games: [], made: [], samples: [] };
  const walkSays = new Map<string, number>(played.total);
  const walkGames = new Map<string, number>(played.games);
  const walkMade = new Map<string, Record<string, number>>(played.made ?? []);
  const idOf = new Map(world.players.map((p) => [normalizeName(p.name), p.playerId]));

  const keyOf = (p: (typeof board)[number]) => p.key;
  /**
   * The regression is the reference the others are measured against
   * because it is the only one with something to say about every player.
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
  /**
   * The walk's totals are raw points, and raw points put every good
   * quarterback above every back, which is true and useless: the board
   * orders by what a player is worth over the one you could have had, so
   * the walk's opinion is taken the same way. The bar per position is
   * the last player a twelve team league starts.
   */
  /**
   * Scored here rather than taken from the file's own total, which was
   * written under standard rules: every one of the 416 totals in the
   * 2026 file matches a line scored at nothing a catch, so a PPR board
   * was placing receivers by a walk that paid them nothing for 130
   * catches. The stored total covers the players the file has no line
   * for.
   */
  const walkSaid = new Map<string, number>();

  for (const p of board) {
    const id = idOf.get(p.key);

    if (id === undefined) {
      continue;
    }

    const made = walkMade.get(id);
    const says = made
      ? pointsOfLine(made as unknown as StatParts)
      : walkSays.get(id);

    if (says !== undefined) {
      walkSaid.set(p.key, says);
    }
  }

  const STARTS = { QB: 12, RB: 34, WR: 26, TE: 12 } as Record<string, number>;
  const walkBar = new Map<string, number>();

  for (const [position, slots] of Object.entries(STARTS)) {
    const theirs = board
      .filter((p) => p.position === position && walkSaid.has(p.key))
      .map((p) => walkSaid.get(p.key)!)
      .sort((a, b) => b - a);
    walkBar.set(position, theirs[Math.min(slots - 1, theirs.length - 1)] ?? 0);
  }

  const walkPlace = onBoard(placesBy(board, keyOf, (p) => {
    const says = walkSaid.get(p.key);

    return says === undefined
      ? null
      : says - (walkBar.get(p.position) ?? 0);
  }));

  if (walkSays.size) {
    console.log(`the played games speak for ${walkPlace.size} of the board`);
  }

  /**
   * What the walk handed him in a game, under its own name because it
   * is not his rate. It throws about a quarter more at the men it likes
   * most than they really get, so a page that led with it said
   * Puka Nacua scored 35.9 a game where the model has him at 21.5. Only
   * the board's ordering reads it now, and it travels as parts because
   * a league paying a point a catch orders receivers differently from
   * one paying nothing.
   *
   * Divided by the games the walk really dealt him, not the fixtures on
   * the calendar. The absences live inside the season now, so a
   * calendar divisor diluted a fragile player's game and his expected
   * games then priced the missing weeks a second time.
   */
  const walkSampled = new Map<string, number>(
    (played.samples ?? []).map(([id, his]) => [id, his.length]),
  );
  const passes = Math.max(1, played.runs ?? 20);

  for (const p of board) {
    const id = idOf.get(p.key);
    const made = id === undefined ? undefined : walkMade.get(id);
    const dealt = id === undefined
      ? 0
      : ((walkSampled.get(id) ?? 0) / passes) || (walkGames.get(id) ?? 0);

    if (made && dealt > 0) {
      (p as unknown as { walked: Record<string, number> }).walked =
        Object.fromEntries(Object.entries(made)
          .map(([part, n]) => [part, Number((n / dealt).toFixed(2))]));
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

  /**
   * Who each side plays each week, so the page can move the players in one
   * game together: the two quarterbacks, and a defence against the
   * offence it is facing.
   */
  const schedule: Record<string, (string | null)[]> = {};

  for (const [team, weeks] of weekOpp) {
    const its = new Array(18).fill(null) as (string | null)[];

    for (const { week, opponent } of weeks) {
      its[week - 1] = opponent;
    }

    schedule[team] = its;
  }

  /**
   * The rules the file was scored under travel with it. Every page
   * rescores the parts in the league in front of it, so nothing on the
   * site reads these, but a reader cannot tell whether ppg and the line
   * beside it agree without knowing what a catch was paid.
   */
  await writeFile(
    join(DOCS, "data", `board-${season}.json`),
    JSON.stringify({
      season, scoredBy: scoring(), players: [...board, ...others], schedule,
    }),
  );
  console.log(`board: ${board.length} players`);

  const argued = disagreements(board, scoring());

  for (const said of argued.slice(0, 10)) {
    console.warn(
      `  ${said.who}: ${said.about} says ${said.worth.toFixed(1)} where the ` +
        `board says ${said.said.toFixed(1)}`);
  }

  console.log(
    argued.length === 0
      ? "every player's points a game match his own line"
      : `${argued.length} players do not agree with their own line`);

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

  /**
   * The tables the live pages play the rest of a game out with. It
   * wants the roster of a week, so it takes the latest week the slate
   * was written for, and a side on its bye that week is filled in from
   * the nearest week it played.
   */
  const latest = index
    .filter((one) => one.season === season)
    .reduce((most, one) => Math.max(most, one.week), 1);
  execFileSync(
    "npx", ["tsx", "scripts/buildSimTables.ts", String(season), String(latest)],
    { cwd: join(import.meta.dirname, ".."), stdio: "inherit" },
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
  await dropStaleAssets();
  console.log(`site written to ${DOCS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

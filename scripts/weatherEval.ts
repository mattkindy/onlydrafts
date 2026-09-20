/**
 * Does the weather at a game move what a skill player scored, and does
 * a fitted weather term beat a line that never saw the forecast?
 *
 * The rival line is his own trailing four game mean inside the season,
 * carried across by the setting lift the slate already applies, so the
 * weather is the only thing it does not know. Fits train on seasons
 * before the one they score, 2021 through 2025 are scored out of
 * sample, and the ceiling is the same fit trained on the season it
 * scores. Wind and temperature come from nflverse, rain and snow from
 * the Open-Meteo archive, which has no column in games.csv.
 *
 * Run: npx tsx scripts/fetchWeatherArchive.ts && npx tsx scripts/weatherEval.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { hoursAt, skyAt, type Sky } from "../src/data/weatherArchive.js";
import { scoring } from "../src/scoring/active.js";
import { fantasyPoints } from "../src/scoring/fantasyPoints.js";
import { settingLift, type Setting } from "../src/features/weekSetting.js";
import { fitRidge } from "../src/backtest/ridge.js";

const SEASONS = [
  2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
];
const SCORED = [2021, 2022, 2023, 2024, 2025];
/** seasons the top third cuts are read off, so the scored ones do not set them */
const CUT_SEASONS = [2015, 2016, 2017, 2018, 2019, 2020];
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

/** how many of his own games the trailing mean reads, as componentWeek does */
const WINDOW = 4;

/** a line under this is noise divided by noise, so the ratio is left alone */
const MIN_LINE = 5;

/** where the weather is supposed to bite, and the games the verdict rests on */
const ROUGH_WIND = 15;
const ROUGH_COLD = 40;

/** millimetres over the three hours that separate a drizzle from a soaking */
const SOAKED_MM = 1;

type Falling = "dry" | "light" | "wet" | "snow";

interface Sample {
  season: number;
  week: number;
  position: string;
  group: string;
  deep: boolean;
  wind: number;
  temp: number;
  falling: Falling;
  soaked: boolean;
  actual: number;
  line: number;
}

// ---------------------------------------------------------------- the games

interface Day extends Setting {
  wind?: number;
  temp?: number;
  sky?: Sky;
}

function fallingFrom(sky: Sky | undefined): Falling {
  if (!sky) {
    return "dry";
  }

  if (sky.snowfall > 0) {
    return "snow";
  }

  if (sky.precipitation >= SOAKED_MM) {
    return "wet";
  }

  return sky.precipitation > 0 ? "light" : "dry";
}

/** how far the archive and nflverse are from each other on the same game */
interface Agreement {
  windGap: number[];
  tempGap: number[];
  windPairs: [number, number][];
  tempPairs: [number, number][];
}

async function daysByTeamWeek(agreement: Agreement): Promise<Map<string, Day>> {
  const out = new Map<string, Day>();
  const histories = new Map<string, Awaited<ReturnType<typeof hoursAt>>>();

  for (const game of await loadGames()) {
    if (!SEASONS.includes(game.season)) {
      continue;
    }

    const key = `${game.homeTeamId}|${game.season}`;

    if (!histories.has(key)) {
      histories.set(
        key,
        await hoursAt(game.homeTeamId, game.season).catch(() => undefined),
      );
    }

    const hourly = histories.get(key);
    const sky = hourly && game.gameday && game.hour !== undefined
      ? skyAt(hourly, game.gameday, game.hour)
      : undefined;

    if (sky && !game.indoors) {
      if (game.wind !== undefined) {
        agreement.windGap.push(sky.wind - game.wind);
        agreement.windPairs.push([sky.wind, game.wind]);
      }

      if (game.temp !== undefined) {
        agreement.tempGap.push(sky.temperature - game.temp);
        agreement.tempPairs.push([sky.temperature, game.temp]);
      }
    }

    const night = (game.hour ?? 13) >= 18;

    for (const [team, rest] of [
      [game.homeTeamId, game.homeRest ?? 7],
      [game.awayTeamId, game.awayRest ?? 7],
    ] as [string, number][]) {
      out.set(`${game.season}|${game.week}|${team}`, {
        indoors: game.indoors,
        night,
        restDays: rest,
        wind: game.wind,
        temp: game.temp,
        sky,
      });
    }
  }

  return out;
}

// ------------------------------------------------------- the player games

interface Played {
  week: number;
  points: number;
  targets: number;
  carries: number;
  airYards: number;
  lift: number;
}

const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

function correlation(pairs: [number, number][]): number {
  const left = mean(pairs.map((p) => p[0]));
  const right = mean(pairs.map((p) => p[1]));
  const top = mean(pairs.map((p) => (p[0] - left) * (p[1] - right)));
  const spread = (i: 0 | 1, at: number) =>
    Math.sqrt(mean(pairs.map((p) => (p[i] - at) ** 2)));
  const under = spread(0, left) * spread(1, right);

  return under > 0 ? top / under : 0;
}

/**
 * His trailing window carried to this week's setting. The window's own
 * games had roofs and Thursdays of their own, so the lift is divided by
 * the window's average rather than multiplied in raw.
 */
function lineFor(window: Played[], lift: number): number {
  const carried = mean(window.map((g) => g.lift));

  return carried > 0 ? mean(window.map((g) => g.points)) * (lift / carried) : 0;
}

/** what share of his touches came through the air over the window */
const catchShare = (window: Played[]) => {
  const targets = window.reduce((s, g) => s + g.targets, 0);
  const touches = targets + window.reduce((s, g) => s + g.carries, 0);

  return touches > 0 ? targets / touches : 0;
};

/** how far downfield he was thrown to over the window */
const depthPerTarget = (window: Played[]) => {
  const targets = window.reduce((s, g) => s + g.targets, 0);

  return targets > 0
    ? window.reduce((s, g) => s + g.airYards, 0) / targets
    : 0;
};

interface Raw {
  season: number;
  week: number;
  position: string;
  catchShare: number;
  depth: number;
  wind: number;
  temp: number;
  falling: Falling;
  actual: number;
  line: number;
}

/**
 * Every outdoor player game with a window behind it, a recorded wind
 * and temperature, and a line worth taking a ratio of. `covered` counts
 * every player game that had a line at all, weather or not, so the
 * affected share has a denominator.
 */
async function gather(days: Map<string, Day>) {
  const rules = scoring();
  const raws: Raw[] = [];
  let covered = 0;

  for (const season of SEASONS) {
    const stats = await loadPlayerStats(season).catch(() => []);
    const byPlayer = new Map<string, typeof stats>();

    for (const s of stats) {
      if (!POSITIONS.has(s.position)) {
        continue;
      }

      const his = byPlayer.get(s.playerId) ?? [];
      his.push(s);
      byPlayer.set(s.playerId, his);
    }

    for (const [, his] of byPlayer) {
      his.sort((a, b) => a.week - b.week);
      const played: Played[] = [];

      for (const s of his) {
        const day = days.get(`${season}|${s.week}|${s.teamId}`);
        const lift = day ? settingLift(s.position, day) : 1;
        const points = fantasyPoints(s.statLine, rules);

        if (played.length >= WINDOW && day) {
          const window = played.slice(-WINDOW);
          const line = lineFor(window, lift);

          if (line >= MIN_LINE) {
            covered += 1;

            if (
              !day.indoors && day.temp !== undefined &&
              day.wind !== undefined && Number.isFinite(day.wind)
            ) {
              raws.push({
                season,
                week: s.week,
                position: s.position,
                catchShare: catchShare(window),
                depth: depthPerTarget(window),
                wind: day.wind,
                temp: day.temp,
                falling: fallingFrom(day.sky),
                actual: points,
                line,
              });
            }
          }
        }

        played.push({
          week: s.week,
          points,
          targets: s.targets,
          carries: s.carries,
          airYards: s.airYards,
          lift,
        });
      }
    }
  }

  return { raws, covered };
}

// --------------------------------------------------------------- the groups

/** the value a third of the sample is above */
function topThirdCut(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.floor(sorted.length * (2 / 3));

  return sorted[Math.min(at, sorted.length - 1)] ?? 0;
}

const GROUPS = ["QB", "RB catching", "RB running", "WR", "TE"] as const;

/** the cuts the groups were drawn at, so a shipped table can use the same ones */
export const cuts = { rb: 0, depth: 0 };

function label(raws: Raw[]): Sample[] {
  const early = raws.filter((r) => CUT_SEASONS.includes(r.season));
  const rbCut = topThirdCut(
    early.filter((r) => r.position === "RB").map((r) => r.catchShare),
  );
  const depthCut = topThirdCut(
    early
      .filter((r) => r.position === "WR" || r.position === "TE")
      .map((r) => r.depth),
  );

  cuts.rb = rbCut;
  cuts.depth = depthCut;

  const groupOf: Record<string, (r: Raw) => string> = {
    QB: () => "QB",
    WR: () => "WR",
    TE: () => "TE",
    RB: (r) => (r.catchShare >= rbCut ? "RB catching" : "RB running"),
  };

  return raws.map((r) => ({
    season: r.season,
    week: r.week,
    position: r.position,
    group: groupOf[r.position]!(r),
    deep: r.depth >= depthCut,
    wind: r.wind,
    temp: r.temp,
    falling: r.falling,
    soaked: r.falling === "wet" || r.falling === "snow",
    actual: r.actual,
    line: r.line,
  }));
}

// ----------------------------------------------------------------- the bins

interface Bin {
  name: string;
  holds: (s: Sample) => boolean;
}

const WIND_BINS: Bin[] = [
  { name: "under 10", holds: (s) => s.wind < 10 },
  { name: "10 to 15", holds: (s) => s.wind >= 10 && s.wind < 15 },
  { name: "15 to 20", holds: (s) => s.wind >= 15 && s.wind < 20 },
  { name: "over 20", holds: (s) => s.wind >= 20 },
];

const TEMP_BINS: Bin[] = [
  { name: "under 32", holds: (s) => s.temp < 32 },
  { name: "32 to 45", holds: (s) => s.temp >= 32 && s.temp < 45 },
  { name: "45 to 60", holds: (s) => s.temp >= 45 && s.temp < 60 },
  { name: "over 60", holds: (s) => s.temp >= 60 },
];

const FALLING_BINS: Bin[] = (["dry", "light", "wet", "snow"] as Falling[])
  .map((what) => ({ name: what, holds: (s: Sample) => s.falling === what }));

interface Cell {
  count: number;
  ratio: number;
  error: number;
  residual: number;
}

function cellOf(samples: Sample[]): Cell {
  const ratios = samples.map((s) => s.actual / s.line);
  const middle = mean(ratios);
  const spread = mean(ratios.map((r) => (r - middle) ** 2));

  return {
    count: samples.length,
    ratio: middle,
    error: samples.length > 1 ? Math.sqrt(spread / samples.length) : 0,
    residual: mean(samples.map((s) => s.actual - s.line)),
  };
}

const cellText = (c: Cell) =>
  c.count === 0
    ? "."
    : `${c.ratio.toFixed(3)} +-${c.error.toFixed(3)} ` +
      `r${c.residual.toFixed(2).padStart(6)} n=${String(c.count).padStart(5)}`;

function binTable(
  title: string,
  bins: Bin[],
  rows: { name: string; samples: Sample[] }[],
): string[] {
  const out = [title, ""];
  out.push(["group".padEnd(13), ...bins.map((b) => b.name.padEnd(32))].join(""));

  for (const row of rows) {
    const cells = bins.map((b) =>
      cellText(cellOf(row.samples.filter((s) => b.holds(s)))).padEnd(32),
    );
    out.push([row.name.padEnd(13), ...cells].join(""));
  }

  out.push("");
  return out;
}

// ------------------------------------------------------------------ the fit

/**
 * Wind above ten and cold below forty, each in tens so a coefficient
 * reads as the ratio move per ten units, the corner where a game is
 * both at once, and a flag for a soaking.
 */
function weatherRow(s: { wind: number; temp: number; soaked: boolean }): number[] {
  const blowing = Math.max(0, s.wind - 10) / 10;
  const cold = Math.max(0, ROUGH_COLD - s.temp) / 10;
  const wet = s.soaked ? 1 : 0;

  return [1, blowing, cold, blowing * cold, wet, wet * cold];
}

/** a small ridge, since the corner column nearly repeats its parts */
const LAMBDA = 5;

/**
 * The groups whose wet by cold term kept its sign across every
 * training window. It flips on a tight end and on a back who catches,
 * so those two are fitted without the column rather than with a
 * coefficient nobody can trust.
 */
const WET_COLD_GROUPS = new Set(["QB", "WR"]);

function fitGroup(samples: Sample[], group?: string): number[] {
  const wide = group === undefined || WET_COLD_GROUPS.has(group);
  const width = wide ? 6 : 5;

  if (samples.length < 50) {
    return new Array<number>(6).fill(0).map((_, i) => (i === 0 ? 1 : 0));
  }

  const weights = fitRidge(
    samples.map((s) => weatherRow(s).slice(0, width)),
    samples.map((s) => s.actual / s.line),
    LAMBDA,
  );

  return wide ? weights : [...weights, 0];
}

/** the fit is a nudge to a line, not a licence to halve it */
const CLIP = 0.25;

const clipped = (x: number) => Math.min(1 + CLIP, Math.max(1 - CLIP, x));

function liftFrom(weights: number[], s: Sample): number {
  return clipped(
    weatherRow(s).reduce((sum, x, i) => sum + x * (weights[i] ?? 0), 0),
  );
}

/** the roughest day the tables are asked about, past which they extrapolate */
const WORST_WIND = 35;
const WORST_COLD = 0;

/**
 * The same fit divided by what it says about a mild still dry day, so a
 * game with no weather in it comes through at one, and held to the
 * range it was fitted over. The intercept is a standing correction to
 * the trailing mean rather than anything the weather did, and a weather
 * term has no business carrying it. This is what weekSetting ships.
 */
function shapeFrom(weights: number[], s: Sample): number {
  const benign = weights[0] ?? 1;

  if (benign <= 0) {
    return 1;
  }

  const held = {
    wind: Math.min(WORST_WIND, s.wind),
    temp: Math.max(WORST_COLD, s.temp),
    soaked: s.soaked,
  };
  const said = weatherRow(held)
    .reduce((sum, x, i) => sum + x * (weights[i] ?? 0), 0) / benign;

  return Math.min(1, Math.max(1 - CLIP, said));
}

// ------------------------------------------------------------------ the run

interface Scored {
  base: number;
  fitted: number;
  shaped: number;
  ceiling: number;
  count: number;
}

const empty = (): Scored =>
  ({ base: 0, fitted: 0, shaped: 0, ceiling: 0, count: 0 });

function add(
  into: Scored,
  s: Sample,
  said: { fitted: number; shaped: number; ceiling: number },
): void {
  into.base += Math.abs(s.actual - s.line);
  into.fitted += Math.abs(s.actual - s.line * said.fitted);
  into.shaped += Math.abs(s.actual - s.line * said.shaped);
  into.ceiling += Math.abs(s.actual - s.line * said.ceiling);
  into.count += 1;
}

const maeLine = (name: string, s: Scored) => {
  if (s.count === 0) {
    return `${name}: nothing`;
  }

  const share = (part: number) => `${(((s.base - part) / s.base) * 100).toFixed(2)}%`;

  return `${name}: n=${String(s.count).padStart(6)}  ` +
    `without ${(s.base / s.count).toFixed(4)}  ` +
    `with ${(s.fitted / s.count).toFixed(4)} (${share(s.fitted)})  ` +
    `shape only ${(s.shaped / s.count).toFixed(4)} (${share(s.shaped)})  ` +
    `ceiling ${(s.ceiling / s.count).toFixed(4)} (${share(s.ceiling)})`;
};

const rough = (s: Sample) =>
  s.wind >= ROUGH_WIND || s.temp < ROUGH_COLD || s.soaked;

function agreementLines(agreement: Agreement): string[] {
  const gap = (name: string, gaps: number[], pairs: [number, number][]) =>
    `${name}: n=${gaps.length}  correlation ${correlation(pairs).toFixed(3)}  ` +
    `archive minus nflverse ${mean(gaps).toFixed(2)}  ` +
    `mean size of the gap ${mean(gaps.map(Math.abs)).toFixed(2)}`;

  return [
    "Does the archive agree with what nflverse wrote down?",
    "",
    gap("wind, mph ", agreement.windGap, agreement.windPairs),
    gap("temp, F   ", agreement.tempGap, agreement.tempPairs),
    "",
  ];
}

async function main(): Promise<void> {
  const began = Date.now();
  const agreement: Agreement = {
    windGap: [], tempGap: [], windPairs: [], tempPairs: [],
  };
  const days = await daysByTeamWeek(agreement);
  const { raws, covered } = await gather(days);
  const samples = label(raws);
  const out: string[] = [];

  out.push("Weather against a line that never saw it");
  out.push("");
  out.push(
    `${samples.length} outdoor player games with a recorded wind and ` +
      `temperature, out of ${covered} with a line at all ` +
      `(${((samples.length / covered) * 100).toFixed(1)}%).`,
  );
  out.push(
    "Wind and temperature are nflverse's. Rain and snow are the " +
      "Open-Meteo archive's, summed over the three hours from kickoff.",
  );
  out.push(
    `A back counts as catching when targets are ${(cuts.rb * 100).toFixed(1)}% ` +
      `or more of his touches over the window, and a receiver counts as deep ` +
      `at ${cuts.depth.toFixed(2)} air yards a target or more. Both cuts are ` +
      `the top third of 2015 to 2020.`,
  );
  out.push("");
  out.push(...agreementLines(agreement));
  out.push(
    "A cell is the mean of actual over line, its standard error, the mean " +
      "residual in points, and the count.",
  );
  out.push("");

  const rows = GROUPS.map((g) => ({
    name: g,
    samples: samples.filter((s) => s.group === g),
  }));

  out.push(...binTable("By wind, mph", WIND_BINS, rows));
  out.push(...binTable("By temperature, F", TEMP_BINS, rows));
  out.push(
    ...binTable(
      `By what fell, light being under ${SOAKED_MM}mm over three hours`,
      FALLING_BINS,
      rows,
    ),
  );

  const catching = samples.filter(
    (s) => s.position === "WR" || s.position === "TE",
  );
  const depthRows = [
    { name: "deep", samples: catching.filter((s) => s.deep) },
    { name: "short", samples: catching.filter((s) => !s.deep) },
  ];
  out.push(
    ...binTable(
      "Receivers by wind, split on air yards a target over the window",
      WIND_BINS,
      depthRows,
    ),
  );
  out.push(
    ...binTable("Receivers by temperature, same split", TEMP_BINS, depthRows),
  );
  out.push(...binTable("Receivers by what fell, same split", FALLING_BINS, depthRows));

  out.push("Fitted coefficients: the ratio move per ten mph of wind above ten,");
  out.push("per ten degrees below forty, the corner term, and a soaking.");
  out.push("");
  out.push(
    "group        train        intercept     wind     cold   corner      wet  wetcold   n",
  );

  const all = empty();
  const affected = empty();
  const byGroup = new Map<string, Scored>(GROUPS.map((g) => [g, empty()]));
  const roughByGroup = new Map<string, Scored>(GROUPS.map((g) => [g, empty()]));

  for (const season of SCORED) {
    for (const group of GROUPS) {
      const mine = samples.filter((s) => s.group === group);
      const before = mine.filter((s) => s.season < season);
      const during = mine.filter((s) => s.season === season);
      const weights = fitGroup(before, group);
      const ceiling = fitGroup(during, group);

      out.push(
        `${group.padEnd(13)}${`to ${season - 1}`.padEnd(13)}` +
          weights.map((w) => w.toFixed(4).padStart(9)).join("") +
          "  " + before.length,
      );

      for (const s of during) {
        const said = {
          fitted: liftFrom(weights, s),
          shaped: shapeFrom(weights, s),
          ceiling: liftFrom(ceiling, s),
        };
        add(all, s, said);
        add(byGroup.get(group)!, s, said);

        if (rough(s)) {
          add(affected, s, said);
          add(roughByGroup.get(group)!, s, said);
        }
      }
    }
  }

  out.push("");
  out.push("Mean absolute error of the weekly line, 2021 to 2025, out of sample");
  out.push("");
  out.push(maeLine("rough games only".padEnd(26), affected));
  out.push(maeLine("all outdoor games".padEnd(26), all));
  out.push(
    `A rough game is wind ${ROUGH_WIND} plus, under ${ROUGH_COLD} F, or ` +
      `${SOAKED_MM}mm of rain or any snow. That is ${affected.count} of ` +
      `${covered} player games with a line, ` +
      `${((affected.count / covered) * 100).toFixed(1)}%.`,
  );
  out.push("");

  for (const group of GROUPS) {
    out.push(maeLine(`rough, ${group}`.padEnd(26), roughByGroup.get(group)!));
  }

  out.push("");

  for (const group of GROUPS) {
    out.push(maeLine(`all outdoor, ${group}`.padEnd(26), byGroup.get(group)!));
  }

  out.push("");
  out.push("Refitted on every season, which is what a shipped table would use");
  out.push("");
  out.push(
    "group        intercept     wind     cold   corner      wet  wetcold   n",
  );

  const everySeason = new Map<string, number[]>();

  for (const group of GROUPS) {
    const mine = samples.filter((s) => s.group === group);
    const weights = fitGroup(mine, group);
    everySeason.set(group, weights);
    out.push(
      group.padEnd(13) +
        weights.map((w) => w.toFixed(4).padStart(9)).join("") +
        "  " + mine.length,
    );
  }

  out.push("");
  out.push("The same divided by its intercept, which is the shape a lift wants");
  out.push("");
  out.push("group             wind     cold   corner      wet  wetcold");

  for (const group of GROUPS) {
    const weights = everySeason.get(group)!;
    const benign = weights[0] ?? 1;
    out.push(
      group.padEnd(13) +
        weights.slice(1).map((w) => (w / benign).toFixed(4).padStart(9)).join(""),
    );
  }

  out.push("");
  out.push(`Bench took ${((Date.now() - began) / 1000).toFixed(1)}s.`);

  const text = out.join("\n") + "\n";
  console.log(text);
  await mkdir(join(import.meta.dirname, "..", "bench"), { recursive: true });
  await writeFile(
    join(import.meta.dirname, "..", "bench", "weather.txt"),
    text,
    "utf8",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

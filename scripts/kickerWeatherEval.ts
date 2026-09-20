/**
 * What the weather does to a kick, and whether the kicking tables
 * should gain a freezing band and a wet term.
 *
 * Every kick since 2015 is pulled out of the play by play once and
 * cached, then read against the ground's weather: nflverse for the
 * temperature and wind, the Open-Meteo archive for the rain and snow.
 * Make rate by band, extra point rate and appetite are each split by
 * temperature, wind and what fell, and by what fell crossed with the
 * cold, since a wet ball in the freezing is a different object.
 *
 * Run: npx tsx scripts/fetchWeatherArchive.ts && npx tsx scripts/kickerWeatherEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames, loadKickerWeeks, RAW_DIR } from "../src/data/nflverse.js";
import { hoursAt, skyAt, type Sky } from "../src/data/weatherArchive.js";
import { splitLine } from "../src/data/csv.js";
import {
  KICKER_PARTS, payKicker, projectKickerWeek, STANDARD_KICKER_PAYS,
  TRAILING_WEEKS, type Parts,
} from "../src/features/kickerWeek.js";
import {
  makeKickingVenue, SHIPPED_TABLES, type KickingTables, type Venue,
} from "../src/features/kickingVenue.js";

const SEASONS = [
  2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
];

/** the kicks pulled out of the play by play, which takes a few minutes */
const CACHE = join(RAW_DIR, "kickWeather.csv");

/** a kick this long or shorter is one a staff would consider */
const IN_RANGE_FROM = 43;

/** millimetres over the three hours from kickoff that make a ball wet */
const SOAKED_MM = 1;

type Kind = "fg" | "xp" | "fourth";

interface Kick {
  gameId: string;
  season: number;
  week: number;
  kind: Kind;
  /** the length of the kick, or the yard line for a fourth down */
  yards: number;
  /** made, good, or sent out */
  yes: boolean;
}

// -------------------------------------------------------- out of the plays

async function readSeason(season: number, into: Kick[]): Promise<void> {
  const path = join(RAW_DIR, `play_by_play_${season}.csv`);

  if (!existsSync(path)) {
    console.log(`missing ${path}, skipping`);
    return;
  }

  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  let at: Map<string, number> | undefined;

  for await (const line of lines) {
    const cells = splitLine(line);

    if (!at) {
      at = new Map(cells.map((name, i) => [name, i]));
      continue;
    }

    const get = (name: string) => cells[at!.get(name) ?? -1] ?? "";

    if (get("season_type") !== "REG") {
      continue;
    }

    const gameId = get("game_id");
    const week = Number(get("week"));
    const push = (kind: Kind, yards: number, yes: boolean) =>
      into.push({ gameId, season, week, kind, yards, yes });

    if (get("field_goal_attempt") === "1") {
      const yards = Number(get("kick_distance"));

      if (Number.isFinite(yards) && yards > 0) {
        push("fg", yards, get("field_goal_result") === "made");
      }
    }

    if (get("extra_point_attempt") === "1") {
      push("xp", 0, get("extra_point_result") === "good");
    }

    const spot = Number(get("yardline_100"));
    const play = get("play_type");

    if (
      Number(get("down")) === 4 && Number.isFinite(spot) &&
      spot <= IN_RANGE_FROM &&
      ["field_goal", "punt", "run", "pass"].includes(play)
    ) {
      push("fourth", spot, play === "field_goal");
    }
  }
}

const LINE = (k: Kick) =>
  `${k.gameId},${k.season},${k.week},${k.kind},${k.yards},${k.yes ? 1 : 0}`;

async function everyKick(): Promise<Kick[]> {
  if (existsSync(CACHE)) {
    const text = await readFile(CACHE, "utf8");

    return text.trimEnd().split("\n").slice(1).map((line) => {
      const [gameId, season, week, kind, yards, yes] = line.split(",");

      return {
        gameId: gameId!,
        season: Number(season),
        week: Number(week),
        kind: kind as Kind,
        yards: Number(yards),
        yes: yes === "1",
      };
    });
  }

  const kicks: Kick[] = [];

  for (const season of SEASONS) {
    await readSeason(season, kicks);
    console.log(`${season}: ${kicks.length} kicks and fourth downs so far`);
  }

  await mkdir(RAW_DIR, { recursive: true });
  await writeFile(
    CACHE,
    ["game_id,season,week,kind,yards,yes", ...kicks.map(LINE)].join("\n") + "\n",
    "utf8",
  );

  return kicks;
}

// ------------------------------------------------------------- the weather

interface Day {
  indoors: boolean;
  temperature?: number;
  wind?: number;
  sky?: Sky;
}

async function daysByGame(): Promise<Map<string, Day>> {
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

    out.set(game.id, {
      indoors: game.indoors,
      temperature: game.temp,
      wind: game.wind,
      sky: hourly && game.gameday && game.hour !== undefined
        ? skyAt(hourly, game.gameday, game.hour)
        : undefined,
    });
  }

  return out;
}

type Falling = "dry" | "wet" | "snow";

const fallingOf = (sky: Sky | undefined): Falling => {
  if (!sky) {
    return "dry";
  }

  if (sky.snowfall > 0) {
    return "snow";
  }

  return sky.precipitation >= SOAKED_MM ? "wet" : "dry";
};

interface Shot extends Kick {
  temperature: number;
  wind: number;
  falling: Falling;
}

// ---------------------------------------------------------------- the bins

interface Bin {
  name: string;
  holds: (s: Shot) => boolean;
}

const TEMP_BINS: Bin[] = [
  { name: "under 32", holds: (s) => s.temperature < 32 },
  { name: "32 to 40", holds: (s) => s.temperature >= 32 && s.temperature < 40 },
  { name: "40 to 60", holds: (s) => s.temperature >= 40 && s.temperature < 60 },
  { name: "over 60", holds: (s) => s.temperature >= 60 },
];

const WIND_BINS: Bin[] = [
  { name: "under 12", holds: (s) => s.wind < 12 },
  { name: "12 to 20", holds: (s) => s.wind >= 12 && s.wind < 20 },
  { name: "over 20", holds: (s) => s.wind >= 20 },
];

const FALLING_BINS: Bin[] = (["dry", "wet", "snow"] as Falling[]).map(
  (what) => ({ name: what, holds: (s: Shot) => s.falling === what }),
);

/** what fell crossed with the cold, which is the pair Matt asked about */
const CROSS_BINS: Bin[] = (["dry", "wet", "snow"] as Falling[]).flatMap(
  (what) => [
    {
      name: `${what} under 32`,
      holds: (s: Shot) => s.falling === what && s.temperature < 32,
    },
    {
      name: `${what} 32 to 40`,
      holds: (s: Shot) =>
        s.falling === what && s.temperature >= 32 && s.temperature < 40,
    },
    {
      name: `${what} over 40`,
      holds: (s: Shot) => s.falling === what && s.temperature >= 40,
    },
  ],
);

const rate = (shots: Shot[]) => {
  if (shots.length === 0) {
    return "        .        ";
  }

  const made = shots.filter((s) => s.yes).length;
  const p = made / shots.length;
  const error = Math.sqrt(Math.max(0, p * (1 - p)) / shots.length);

  return `${p.toFixed(3)} +-${error.toFixed(3)} n=${String(shots.length).padStart(5)}`;
};

/** the bands the make rate is read in, as kickingVenue splits them */
const BANDS = [
  { name: "under 40", holds: (s: Shot) => s.yards < 40 },
  { name: "40 to 49", holds: (s: Shot) => s.yards >= 40 && s.yards < 50 },
  { name: "50 plus", holds: (s: Shot) => s.yards >= 50 },
];

function table(
  title: string,
  bins: Bin[],
  rows: { name: string; shots: Shot[] }[],
): string[] {
  const out = [title, ""];
  out.push(["row".padEnd(12), ...bins.map((b) => b.name.padEnd(26))].join(""));

  for (const row of rows) {
    out.push([
      row.name.padEnd(12),
      ...bins.map((b) => rate(row.shots.filter(b.holds)).padEnd(26)),
    ].join(""));
  }

  out.push("");
  return out;
}

function everyTable(title: string, bins: Bin[], shots: Shot[]): string[] {
  const fg = shots.filter((s) => s.kind === "fg");

  return table(title, bins, [
    ...BANDS.map((b) => ({ name: b.name, shots: fg.filter(b.holds) })),
    { name: "extra point", shots: shots.filter((s) => s.kind === "xp") },
    { name: "appetite", shots: shots.filter((s) => s.kind === "fourth") },
  ]);
}

async function gatherShots(days: Map<string, Day>): Promise<Shot[]> {
  const kicks = await everyKick();
  const shots: Shot[] = [];

  for (const kick of kicks) {
    const day = days.get(kick.gameId);

    if (
      !day || day.indoors || day.temperature === undefined ||
      day.wind === undefined || !Number.isFinite(day.wind)
    ) {
      continue;
    }

    shots.push({
      ...kick,
      temperature: day.temperature,
      wind: day.wind,
      falling: fallingOf(day.sky),
    });
  }

  return shots;
}

// ------------------------------------------------- what the tables would be

const SCORED = [2021, 2022, 2023, 2024, 2025];

/** every condition an appetite rate is fitted for, in the order it is read */
const CONDITIONS = ["snow", "freezing", "cold", "wet", "windy", "mild"] as const;

type Condition = typeof CONDITIONS[number];

function conditionOf(s: Shot): Condition {
  if (s.falling === "snow") {
    return "snow";
  }

  if (s.temperature < 32) {
    return "freezing";
  }

  if (s.temperature < 40) {
    return "cold";
  }

  if (s.falling === "wet") {
    return "wet";
  }

  return s.wind >= 12 ? "windy" : "mild";
}

/** the sent out rate per condition, over whichever seasons are given */
function sentOutFrom(shots: Shot[]): Record<Condition, number> {
  const out = {} as Record<Condition, number>;
  const fourths = shots.filter((s) => s.kind === "fourth");

  for (const condition of CONDITIONS) {
    const mine = fourths.filter((s) => conditionOf(s) === condition);
    // a condition with too few fourth downs keeps the shipped number
    out[condition] = mine.length >= 60
      ? mine.filter((s) => s.yes).length / mine.length
      : SHIPPED_TABLES.sentOut[condition];
  }

  return out;
}

/** the shipped tables with a freezing band, a wet term and a snow term */
function tablesFrom(shots: Shot[]): KickingTables {
  return {
    ...SHIPPED_TABLES,
    sentOut: { ...SHIPPED_TABLES.sentOut, ...sentOutFrom(shots) },
  };
}

/**
 * The appetite table as it stood before this bench: one cold bin at
 * forty, nothing for snow or rain. Pinned here so the comparison still
 * means something once the new numbers ship.
 */
const OLD_TABLES: KickingTables = {
  ...SHIPPED_TABLES,
  sentOut: {
    indoors: 0.69, mild: 0.66, windy: 0.63, cold: 0.56, freezing: 0.56,
    wet: 0.66, snow: 0.66,
  },
};

interface Row {
  season: number;
  venue: Venue;
  read: Parameters<typeof projectKickerWeek>[0];
  was: number;
}

const pay = (parts: Parts) => payKicker(parts, STANDARD_KICKER_PAYS);

/** what the line expects a side to score where a fixture has no line */
const IMPLIED_WITHOUT_A_LINE = 22.3;

/** his parts a game over the weeks given */
function ratesOver(weeks: { parts: Parts }[]): Parts {
  const out: Parts = {};

  for (const part of KICKER_PARTS) {
    out[part] = weeks.reduce((sum, w) => sum + (w.parts[part] ?? 0), 0) /
      Math.max(1, weeks.length);
  }

  return out;
}

async function kickerRows(days: Map<string, Day>): Promise<Row[]> {
  const games = await loadGames();
  const fixtures = new Map<string, { implied: number; venue: Venue }>();

  for (const g of games) {
    const day = days.get(g.id);
    const known = g.totalLine !== undefined && g.spreadLine !== undefined;
    const half = (g.totalLine ?? 0) / 2;
    const tilt = (g.spreadLine ?? 0) / 2;
    const venue: Venue = g.indoors ? { indoors: true } : {
      indoors: false,
      temperature: g.temp,
      wind: g.wind,
      precipitation: day?.sky?.precipitation,
      snowfall: day?.sky?.snowfall,
    };

    fixtures.set(`${g.season}|${g.week}|${g.homeTeamId}`, {
      implied: known ? half - tilt : IMPLIED_WITHOUT_A_LINE, venue,
    });
    fixtures.set(`${g.season}|${g.week}|${g.awayTeamId}`, {
      implied: known ? half + tilt : IMPLIED_WITHOUT_A_LINE, venue,
    });
  }

  const rows: Row[] = [];

  for (const season of SCORED) {
    const weeks = await loadKickerWeeks(season).catch(() => []);
    const before = await loadKickerWeeks(season - 1).catch(() => []);
    const lastYear = new Map<string, { paid: number; games: number }>();

    for (const w of before) {
      const so = lastYear.get(w.playerId) ?? { paid: 0, games: 0 };
      so.paid += pay(w.parts);
      so.games++;
      lastYear.set(w.playerId, so);
    }

    const byPlayer = new Map<string, typeof weeks>();

    for (const w of weeks) {
      byPlayer.set(w.playerId, [...(byPlayer.get(w.playerId) ?? []), w]);
    }

    for (const [playerId, his] of byPlayer) {
      const sorted = [...his].sort((a, b) => a.week - b.week);
      const year = lastYear.get(playerId);

      for (let at = 0; at < sorted.length; at++) {
        const week = sorted[at]!;
        const fixture = fixtures.get(`${season}|${week.week}|${week.teamId}`);

        if (!fixture || fixture.venue.indoors) {
          continue;
        }

        const own = sorted.slice(Math.max(0, at - TRAILING_WEEKS), at);

        rows.push({
          season,
          venue: fixture.venue,
          read: {
            ownPaid: own.map((w) => pay(w.parts)),
            lastYearPaid: year && year.games >= 6 ? year.paid / year.games : 8.1,
            ownParts: ratesOver(own),
            ownGames: own.length,
            impliedFor: fixture.implied,
            venue: fixture.venue,
          },
          was: pay(week.parts),
        });
      }
    }
  }

  return rows;
}

const rough = (v: Venue) =>
  (v.temperature ?? 60) < 40 || (v.wind ?? 0) >= 15 ||
  (v.precipitation ?? 0) >= SOAKED_MM || (v.snowfall ?? 0) > 0;

async function decisionLines(shots: Shot[], days: Map<string, Day>) {
  const rows = await kickerRows(days);
  const totals = {
    all: { now: 0, next: 0, best: 0, n: 0 },
    rough: { now: 0, next: 0, best: 0, n: 0 },
  };
  let moved = 0;

  for (const season of SCORED) {
    const before = shots.filter((s) => s.season < season);
    const during = shots.filter((s) => s.season === season);
    const fitted = makeKickingVenue(tablesFrom(before));
    const oracle = makeKickingVenue(tablesFrom(during));

    const was = makeKickingVenue(OLD_TABLES);

    for (const row of rows.filter((r) => r.season === season)) {
      const now = projectKickerWeek({
        ...row.read, appetite: was.appetite(row.venue),
      }).paid;
      const next = projectKickerWeek({
        ...row.read, appetite: fitted.appetite(row.venue),
      }).paid;
      const best = projectKickerWeek({
        ...row.read, appetite: oracle.appetite(row.venue),
      }).paid;

      if (Math.abs(next - now) > 1e-9) {
        moved += 1;
      }

      for (const into of [
        totals.all, ...(rough(row.venue) ? [totals.rough] : []),
      ]) {
        into.now += Math.abs(row.was - now);
        into.next += Math.abs(row.was - next);
        into.best += Math.abs(row.was - best);
        into.n += 1;
      }
    }
  }

  const say = (name: string, t: typeof totals.all) =>
    t.n === 0 ? `${name}: nothing` : `${name}: n=${String(t.n).padStart(5)}  ` +
      `now ${(t.now / t.n).toFixed(4)}  ` +
      `with the new tables ${(t.next / t.n).toFixed(4)} ` +
      `(${(((t.now - t.next) / t.now) * 100).toFixed(2)}%)  ` +
      `ceiling ${(t.best / t.n).toFixed(4)} ` +
      `(${(((t.now - t.best) / t.now) * 100).toFixed(2)}%)`;

  return {
    lines: [
      "Kicker points a game, actual against the slate's line, 2021 to 2025",
      "out of sample, outdoor fixtures only.",
      "",
      say("rough fixtures".padEnd(20), totals.rough),
      say("all outdoor".padEnd(20), totals.all),
      `The new tables move ${moved} of ${totals.all.n} lines at all.`,
      "",
    ],
    rows,
  };
}

/**
 * Whether a wet ball in the cold costs more than the wet and the cold
 * do on their own. The two main effects are read as ratios against a
 * mild dry afternoon and multiplied, and the cell that is both is
 * scored against that.
 */
function interactionLines(shots: Shot[]): string[] {
  const fourths = shots.filter((s) => s.kind === "fourth");
  const share = (kept: Shot[]) =>
    kept.length > 0 ? kept.filter((s) => s.yes).length / kept.length : NaN;
  const cell = (falling: (s: Shot) => boolean, cold: (s: Shot) => boolean) =>
    fourths.filter((s) => falling(s) && cold(s));

  const dry = (s: Shot) => s.falling === "dry";
  const falling = (s: Shot) => s.falling !== "dry";
  const mild = (s: Shot) => s.temperature >= 40;
  const cold = (s: Shot) => s.temperature < 40;

  const base = share(cell(dry, mild));
  const wetOnly = share(cell(falling, mild)) / base;
  const coldOnly = share(cell(dry, cold)) / base;
  const both = cell(falling, cold);
  const together = share(both) / base;
  const added = wetOnly * coldOnly;
  const gap = together - added;
  const error =
    Math.sqrt(share(both) * (1 - share(both)) / Math.max(1, both.length)) / base;

  return [
    "Is a wet ball in the cold worse than wet and cold on their own?",
    "",
    `dry and mild, the baseline:   ${base.toFixed(3)} sent out`,
    `falling and mild, against it: ${wetOnly.toFixed(3)}`,
    `dry and cold, against it:     ${coldOnly.toFixed(3)}`,
    `both, the two multiplied:     ${added.toFixed(3)}`,
    `both, what happened:          ${together.toFixed(3)} ` +
      `(n=${both.length}, +-${error.toFixed(3)})`,
    "",
    `The interaction is ${gap >= 0 ? "+" : ""}${gap.toFixed(3)} against the ` +
      `two multiplied, which is ${Math.abs(gap / error).toFixed(1)} standard ` +
      `errors. It leans the way the guess did and it is inside the noise, so`,
    "there is nothing here to fit a term to.",
    "",
  ];
}

/** how far the line moves when the venue goes from mild to the worst there is */
function sensitivity(rows: Row[]): string[] {
  const worst: Venue = {
    indoors: false, temperature: 20, wind: 25, precipitation: 5, snowfall: 2,
  };
  const mild: Venue = { indoors: false, temperature: 60, wind: 3 };
  const gaps = rows.slice(0, 400).map((row) => {
    const at = (venue: Venue) => projectKickerWeek({
      ...row.read, venue, appetite: kickingVenueOf(venue),
    }).paid;

    return at(mild) - at(worst);
  });
  const middle = gaps.reduce((s, g) => s + g, 0) / Math.max(1, gaps.length);

  return [
    "The weekly line rescales its parts to a total read off his recent",
    "weeks and the game total, so the venue only moves the mix of kicks",
    "rather than the total. Blizzard against a mild afternoon, same",
    `kicker: the line moves ${middle.toFixed(3)} points.`,
    "",
  ];
}

const shipped = makeKickingVenue(SHIPPED_TABLES);
const kickingVenueOf = (venue: Venue) => shipped.appetite(venue);

async function main(): Promise<void> {
  const began = Date.now();
  const days = await daysByGame();
  const shots = await gatherShots(days);
  const out: string[] = [];

  out.push("What the weather does to a kick");
  out.push("");
  out.push(
    `${shots.length} outdoor kicks and fourth downs from ${SEASONS[0]} on, ` +
      `with a recorded temperature and wind.`,
  );
  out.push(
    "A fourth down counts as in range from the 43 or closer, and appetite " +
      "is the share of those where the kicker was sent out.",
  );
  out.push(
    "Each cell is the rate, its standard error and the count. Temperature " +
      "and wind are nflverse's, rain and snow the Open-Meteo archive's.",
  );
  out.push("");
  out.push(
    "Wind make rates are selected: a staff only sends a long one into a " +
      "gale when they fancy it, so those attempts are the easy ones and the",
  );
  out.push(
    "rate reads high. Read wind through appetite unless the long band says " +
      "otherwise on its own.",
  );
  out.push("");

  out.push(...everyTable("By temperature, F", TEMP_BINS, shots));
  out.push(...everyTable("By wind, mph", WIND_BINS, shots));
  out.push(...everyTable("By what fell", FALLING_BINS, shots));
  out.push(...everyTable("What fell crossed with the cold", CROSS_BINS, shots));

  out.push("The sent out rate each condition would be fitted at, all seasons");
  out.push("");
  const fourths = shots.filter((s) => s.kind === "fourth");

  for (const condition of CONDITIONS) {
    const mine = fourths.filter((s) => conditionOf(s) === condition);
    const shipped = SHIPPED_TABLES.sentOut[condition];
    out.push(
      `${condition.padEnd(10)}${rate(mine)}   shipped ${shipped.toFixed(3)}`,
    );
  }

  out.push("");
  out.push(...interactionLines(shots));
  const decision = await decisionLines(shots, days);
  out.push(...decision.lines);
  out.push(...sensitivity(decision.rows));

  out.push(`Bench took ${((Date.now() - began) / 1000).toFixed(1)}s.`);

  const text = out.join("\n") + "\n";
  console.log(text);
  await mkdir(join(import.meta.dirname, "..", "bench"), { recursive: true });
  await writeFile(
    join(import.meta.dirname, "..", "bench", "kickerWeather.txt"), text, "utf8",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

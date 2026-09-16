/**
 * Standing at the end of week W, how well does each way of reading a
 * player predict what he averages from week W plus 1 to week 18?
 *
 * The readers are marked at the same cuts on the same players: the
 * preseason anchor the board ships now, his points a game so far, the
 * update, the update with one part switched off, and a reader who knew
 * the answer. Every fit is trained on seasons before the one predicted.
 *
 * Run: npx tsx scripts/inSeasonLevelEval.ts
 */

import { loadGames } from "../src/data/nflverse.js";
import {
  readPlayedWeeks,
  roleRowsFrom,
  SHIPPED_SHAPE,
} from "../src/features/inSeasonBoard.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
} from "../src/features/seasonModel.js";
import {
  fitRookieModel,
  predictRookie,
  rookiesFor,
} from "../src/features/rookies.js";
import {
  fitInSeasonUpdate,
  fitUpdateShape,
  updateLevel,
  type InSeasonFit,
  type PlayedWeek,
  type RoleLevelRow,
  type UpdateCase,
  type UpdateShape,
} from "../src/features/inSeasonLevel.js";

const FIRST_DATA = 2015;
/** the first season a transition can be built for */
const FIRST_ANCHOR = 2017;
/** the first season with an earlier transition to fit an anchor on */
const FIRST_BOARD = 2018;
const LAST_PLAYED = 2025;
/** the season the board is on now, which has only a few weeks in it */
const LIVE = 2026;
const MARKED = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const CUTS = [2, 4, 6, 8, 10];
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
/** games after the cut a player needs before his average means anything */
const MIN_REST_GAMES = 3;
/** the share of players counted as having a changed role */
const SURPRISE_SHARE = 0.25;

interface Anchor {
  ppg: number;
  position: string;
  name: string;
}

interface Season {
  anchors: Map<string, Anchor>;
  weeks: Map<string, PlayedWeek[]>;
  roleRows: RoleLevelRow[];
}

function seasons(from: number, to: number): number[] {
  const all: number[] = [];

  for (let s = from; s <= to; s++) {
    all.push(s);
  }

  return all;
}

type Rookies = Awaited<ReturnType<typeof rookiesFor>>;
type Examples = Awaited<ReturnType<typeof examplesForTransition>>;

interface Prior {
  examples: Map<number, Examples>;
  /** first year players only, which is what the rookie fit is trained on */
  rookies: Map<number, Rookies>;
  /** those plus anyone the board has no season to read, for predicting */
  unread: Map<number, Rookies>;
}

function anchorsFor(season: number, prior: Prior): Map<string, Anchor> {
  const train: Examples = [];
  const rookieTrain: Rookies = [];

  for (const year of seasons(FIRST_ANCHOR, season - 1)) {
    train.push(...prior.examples.get(year)!);
    rookieTrain.push(...prior.rookies.get(year)!);
  }

  const fit = fitSeasonModel(train);
  const rookieWeights = fitRookieModel(rookieTrain);
  const anchors = new Map<string, Anchor>();

  for (const e of prior.examples.get(season)!) {
    if (!POSITIONS.has(e.position)) {
      continue;
    }

    anchors.set(e.playerId, {
      ppg: predictSeasonBlend(fit, e),
      position: e.position,
      name: e.playerName ?? e.playerId,
    });
  }

  for (const r of prior.unread.get(season)!) {
    if (anchors.has(r.playerId) || !POSITIONS.has(r.position)) {
      continue;
    }

    anchors.set(r.playerId, {
      ppg: predictRookie(rookieWeights, r),
      position: r.position,
      name: r.name,
    });
  }

  return anchors;
}

interface Row extends UpdateCase {
  playerId: string;
  name: string;
  season: number;
  cut: number;
  toDatePpg: number;
}

function rowsAt(season: Season, year: number, cut: number): Row[] {
  const rows: Row[] = [];

  for (const [playerId, anchor] of season.anchors) {
    const his = season.weeks.get(playerId) ?? [];
    const before = his.filter((w) => w.week <= cut);
    const after = his.filter((w) => w.week > cut);

    if (before.length === 0 || after.length < MIN_REST_GAMES) {
      continue;
    }

    rows.push({
      playerId,
      name: anchor.name,
      season: year,
      cut,
      position: anchor.position,
      anchor: anchor.ppg,
      weeks: before,
      restPpg: after.reduce((sum, w) => sum + w.points, 0) / after.length,
      toDatePpg: before.reduce((sum, w) => sum + w.points, 0) / before.length,
    });
  }

  return rows;
}

function mae(said: number[], was: number[]): number {
  return said.reduce((s, p, i) => s + Math.abs(p - was[i]!), 0) / said.length;
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;
  let together = 0;
  let spreadA = 0;
  let spreadB = 0;

  for (let i = 0; i < n; i++) {
    together += (a[i]! - meanA) * (b[i]! - meanB);
    spreadA += (a[i]! - meanA) ** 2;
    spreadB += (b[i]! - meanB) ** 2;
  }

  return together / Math.sqrt(spreadA * spreadB);
}

interface Marked {
  cut: number;
  was: number[];
  said: Record<string, number[]>;
  surprise: boolean[];
}

const UPDATE = "the update";
const ABLATIONS = {
  "no role term": { roleCap: 0 },
  "role term only": { pointsCap: 0 },
  "no recency, no break": { decay: 1, breakGap: Infinity },
} as const;

/**
 * The constant the build ships, marked here for reference rather than
 * as a rival: it was fitted over every season including the ones it is
 * scored on, so its number is in sample and flatters itself.
 */
const SHIPPED = "shipped shape, in sample";

const READERS = [
  "preseason anchor",
  "season to date",
  UPDATE,
  ...Object.keys(ABLATIONS),
  SHIPPED,
  "oracle",
];

function report(marked: Marked): void {
  const surprised = marked.surprise.filter(Boolean).length;

  console.log(
    `\nafter week ${marked.cut}: ${marked.was.length} players, ` +
      `${surprised} of them with a changed role`,
  );
  console.log(
    "".padEnd(26) + "MAE    corr    role changed: MAE    corr",
  );

  for (const reader of READERS) {
    const said = marked.said[reader]!;
    const keptSaid = said.filter((_, i) => marked.surprise[i]);
    const keptWas = marked.was.filter((_, i) => marked.surprise[i]);

    console.log(
      `${reader.padEnd(26)}${mae(said, marked.was).toFixed(3)}  ` +
        `${correlation(said, marked.was).toFixed(3)}   ` +
        `${mae(keptSaid, keptWas).toFixed(3).padStart(15)}  ` +
        `${correlation(keptSaid, keptWas).toFixed(3)}`,
    );
  }
}

/**
 * How far this season has moved a player from where August had him, in
 * units of his own projection, read off his usage so the split is not
 * made by the same points the update is marked against.
 */
function surpriseOf(fit: InSeasonFit, row: Row): number {
  const said = updateLevel(fit, row);

  return Math.abs(said.roleLevel - row.anchor) / Math.max(4, row.anchor);
}

function describe(shape: UpdateShape): string {
  const gap = Number.isFinite(shape.breakGap)
    ? shape.breakGap.toFixed(2)
    : "off";

  return (
    `role ${shape.roleCap} at half by ${shape.roleGames}, ` +
    `points ${shape.pointsCap} at half by ${shape.pointsGames}, ` +
    `decay ${shape.decay}, break ${gap}`
  );
}

function cutAt(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.floor(sorted.length * (1 - share));

  return sorted[Math.min(at, sorted.length - 1)] ?? Infinity;
}

async function main(): Promise<void> {
  const years = seasons(FIRST_DATA, LIVE);
  const data = await buildSeasonData(years);
  const games = await loadGames();
  const prior: Prior = {
    examples: new Map(),
    rookies: new Map(),
    unread: new Map(),
  };

  for (const year of seasons(FIRST_ANCHOR, LIVE)) {
    prior.examples.set(year, await examplesForTransition(year, data));
    prior.rookies.set(year, await rookiesFor(year, data, games));
    prior.unread.set(
      year,
      await rookiesFor(year, data, games, { alsoUnread: true }),
    );
  }

  const built = new Map<number, Season>();

  for (const year of seasons(FIRST_BOARD, LIVE)) {
    const anchors = anchorsFor(year, prior);
    const read = await readPlayedWeeks(year);

    for (const [playerId, anchor] of anchors) {
      anchor.name = read.byName.get(playerId) ?? anchor.name;
    }

    built.set(year, {
      anchors,
      weeks: read.weeks,
      roleRows: roleRowsFrom(read),
    });
    console.log(`${year}: ${anchors.size} anchors, ${read.weeks.size} played`);
  }

  const marked = new Map<number, Marked>(
    CUTS.map((cut) => [
      cut,
      {
        cut,
        was: [],
        said: Object.fromEntries(READERS.map((r) => [r, []])),
        surprise: [],
      },
    ]),
  );
  const fits = new Map<number, InSeasonFit>();

  for (const year of [...MARKED, LIVE]) {
    const roleRows: RoleLevelRow[] = [];
    const cases: UpdateCase[] = [];

    for (const earlier of seasons(
      FIRST_BOARD,
      Math.min(year - 1, LAST_PLAYED),
    )) {
      const season = built.get(earlier)!;
      roleRows.push(...season.roleRows);

      for (const cut of CUTS) {
        cases.push(...rowsAt(season, earlier, cut));
      }
    }

    const fit = fitInSeasonUpdate(roleRows, cases);
    fits.set(year, fit);
    console.log(`${year}: ${roleRows.length} player seasons, ` +
      `${cases.length} training cuts, ${describe(fit.shape)}`);

    /**
     * The same fit with one part switched off, so each part is marked
     * against the update without it rather than against nothing.
     */
    const without = new Map<string, InSeasonFit>();

    for (const [label, held] of year === LIVE ? [] : Object.entries(ABLATIONS)) {
      const fixed = { decay: fit.shape.decay, breakGap: fit.shape.breakGap, ...held };
      without.set(label, {
        role: fit.role,
        shape: fitUpdateShape(fit.role, cases, fixed),
      });
    }

    for (const cut of CUTS) {
      const rows = rowsAt(built.get(year)!, year, cut);
      const surprises = rows.map((row) => surpriseOf(fit, row));
      const line = cutAt(surprises, SURPRISE_SHARE);
      const into = marked.get(cut)!;

      rows.forEach((row, i) => {
        into.was.push(row.restPpg);
        into.said["preseason anchor"]!.push(row.anchor);
        into.said["season to date"]!.push(row.toDatePpg);
        into.said[UPDATE]!.push(updateLevel(fit, row).ppg);
        into.said[SHIPPED]!.push(
          updateLevel({ role: fit.role, shape: SHIPPED_SHAPE }, row).ppg,
        );
        into.said["oracle"]!.push(row.restPpg);

        for (const [label, ablated] of without) {
          into.said[label]!.push(updateLevel(ablated, row).ppg);
        }

        into.surprise.push(surprises[i]! >= line);
      });
    }
  }

  for (const cut of CUTS) {
    report(marked.get(cut)!);
  }

  showMovers(built, fits);

  for (const [year, who] of TRACED) {
    trace(built.get(year), fits.get(year), year, who);
  }

  showLive(built, fits.get(LIVE)!);
}

/** players worth following cut by cut, by season and by name */
const TRACED: [number, string][] = [
  [2025, "Travis Hunter"],
  [LIVE, "Travis Hunter"],
  [2023, "Puka Nacua"],
  [2020, "Michael Thomas"],
  [2025, "Rico Dowdle"],
];

/** one player's number at each cut, against what he went on to average */
function trace(
  season: Season | undefined,
  fit: InSeasonFit | undefined,
  year: number,
  who: string,
): void {
  const found = [...(season?.anchors ?? [])].find(
    ([, anchor]) => anchor.name === who,
  );

  if (!season || !fit || !found) {
    console.log(`\n${who} ${year}: no anchor on file`);

    return;
  }

  const [playerId, anchor] = found;
  const his = season.weeks.get(playerId) ?? [];
  console.log(
    `\n${who} ${year}, anchor ${anchor.ppg.toFixed(1)} at ${anchor.position}`,
  );
  console.log("cut  games  snaps  to date  role  update  rest of season");

  for (const cut of CUTS) {
    const before = his.filter((w) => w.week <= cut);
    const after = his.filter((w) => w.week > cut);

    if (before.length === 0) {
      continue;
    }

    const said = updateLevel(fit, {
      anchor: anchor.ppg,
      position: anchor.position,
      weeks: before,
    });
    const snaps = before.reduce((s, w) => s + w.snapShare, 0) / before.length;
    const rest = after.length === 0
      ? "none"
      : (after.reduce((s, w) => s + w.points, 0) / after.length).toFixed(1);

    console.log(
      `${String(cut).padStart(3)}${String(before.length).padStart(7)}` +
        `${snaps.toFixed(2).padStart(7)}${said.toDatePpg.toFixed(1).padStart(9)}` +
        `${said.roleLevel.toFixed(1).padStart(6)}${said.ppg.toFixed(1).padStart(8)}` +
        `${rest.padStart(16)}`,
    );
  }
}

/** the players this season moved furthest, and what each reader said */
function showMovers(
  built: Map<number, Season>,
  fits: Map<number, InSeasonFit>,
): void {
  const cut = 6;
  const shown: {
    name: string; season: number; anchor: number; toDate: number;
    role: number; update: number; was: number;
  }[] = [];

  for (const year of MARKED) {
    const fit = fits.get(year)!;

    for (const row of rowsAt(built.get(year)!, year, cut)) {
      const said = updateLevel(fit, row);
      shown.push({
        name: row.name,
        season: year,
        anchor: row.anchor,
        toDate: row.toDatePpg,
        role: said.roleLevel,
        update: said.ppg,
        was: row.restPpg,
      });
    }
  }

  shown.sort((a, b) => Math.abs(b.role - b.anchor) - Math.abs(a.role - a.anchor));
  console.log(`\nthe twelve biggest role moves after week ${cut}`);
  console.log(
    "player".padEnd(24) + "season  anchor  to date  role  update  actual",
  );

  for (const row of shown.slice(0, 12)) {
    console.log(
      row.name.padEnd(24) +
        `${row.season}  ${row.anchor.toFixed(1).padStart(6)}  ` +
        `${row.toDate.toFixed(1).padStart(7)}  ${row.role.toFixed(1).padStart(4)}  ` +
        `${row.update.toFixed(1).padStart(6)}  ${row.was.toFixed(1).padStart(6)}`,
    );
  }
}

/** what the update says about the season the board is actually on */
function showLive(built: Map<number, Season>, fit: InSeasonFit): void {
  const season = built.get(LIVE);

  if (!season) {
    return;
  }

  const shown: { name: string; games: number; anchor: number; said: number }[] = [];

  for (const [playerId, anchor] of season.anchors) {
    const weeks = season.weeks.get(playerId) ?? [];

    if (weeks.length === 0) {
      continue;
    }

    const said = updateLevel(fit, {
      anchor: anchor.ppg,
      position: anchor.position,
      weeks,
    });
    shown.push({
      name: anchor.name,
      games: weeks.length,
      anchor: anchor.ppg,
      said: said.ppg,
    });
  }

  shown.sort((a, b) => Math.abs(b.said - b.anchor) - Math.abs(a.said - a.anchor));
  console.log(`\n${LIVE} so far, the ten the update moves furthest`);
  console.log("player".padEnd(24) + "games  anchor  update");

  for (const row of shown.slice(0, 10)) {
    console.log(
      row.name.padEnd(24) +
        `${String(row.games).padStart(5)}  ${row.anchor.toFixed(1).padStart(6)}  ` +
        `${row.said.toFixed(1).padStart(6)}`,
    );
  }

  const hunter = shown.find((row) => row.name.includes("Hunter"));

  if (hunter) {
    console.log(
      `\n${hunter.name}: anchor ${hunter.anchor.toFixed(1)}, ` +
        `update ${hunter.said.toFixed(1)} off ${hunter.games} games`,
    );
  }
}

await main();

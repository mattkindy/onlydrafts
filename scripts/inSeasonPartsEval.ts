/**
 * Standing at the end of week W, how close is a player's projected stat
 * line to the line he goes on to put up per game from W plus 1 to 18?
 *
 * Four readers on the same players at the same cuts: the preseason line
 * the build ships, that line scaled by however far the level moved, the
 * line with usage taken from this season, and what he has done so far.
 * The score is a part's mean absolute error over the mean of that part
 * at his position, averaged across parts, so targets and touchdowns
 * count the same. Every fit is trained on seasons before the one read.
 *
 * Run: npx tsx scripts/inSeasonPartsEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import {
  readPlayedWeeks,
  roleRowsFrom,
  SHIPPED_SHAPE,
} from "../src/features/inSeasonBoard.js";
import {
  fitRoleLevel,
  summarizeWindow,
  updateLevel,
  type InSeasonFit,
  type RoleLevelRow,
} from "../src/features/inSeasonLevel.js";
import { updateParts } from "../src/features/inSeasonParts.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
  type SeasonExample,
} from "../src/features/seasonModel.js";
import {
  blankParts,
  fitPartsModel,
  partsByPosition,
  predictParts,
} from "../src/features/partsModel.js";
import { PART_NAMES, type StatParts } from "../src/features/seasonSummary.js";

const FIRST_DATA = 2015;
const FIRST_TRANSITION = 2017;
const LAST_PLAYED = 2025;
const MARKED = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const CUTS = [4, 8, 12];
const POSITIONS = ["QB", "RB", "WR", "TE"];
/** how many earlier seasons the role model learns from */
const ROLE_SEASONS = 8;
/** games after the cut before his per-game line means anything */
const MIN_REST_GAMES = 3;
/**
 * A part is left out of the score where a position barely records it,
 * against the biggest part it does record. A receiver throws a pass
 * every few seasons and dividing by that mean drowns everything else.
 */
const TOO_SMALL_SHARE = 0.01;

const TODAY = "level only, parts as they were";
const SCALED = "every part scaled by the level";
const USAGE_LED = "usage from this season";
const TO_DATE = "his line so far";
const ORACLE = "oracle";
const READERS = [TODAY, SCALED, USAGE_LED, TO_DATE, ORACLE];

function seasons(from: number, to: number): number[] {
  const all: number[] = [];

  for (let s = from; s <= to; s++) {
    all.push(s);
  }

  return all;
}

interface Marked {
  position: string;
  was: StatParts;
  said: Record<string, StatParts>;
}

/** a player's per-game line over some stretch of a season */
function perGame(rows: Awaited<ReturnType<typeof loadPlayerStats>>): StatParts {
  const total = blankParts();

  for (const row of rows) {
    total.passYds += row.statLine.passYds;
    total.passTd += row.statLine.passTd;
    total.interceptions += row.statLine.interceptions;
    total.rushYds += row.statLine.rushYds;
    total.rushTd += row.statLine.rushTd;
    total.receptions += row.statLine.receptions;
    total.recYds += row.statLine.recYds;
    total.recTd += row.statLine.recTd;
    total.passAtt += row.passing.attempts;
    total.passCmp += row.passing.completions;
    total.carries += row.carries;
    total.targets += row.targets;
  }

  for (const part of PART_NAMES) {
    total[part] /= Math.max(1, rows.length);
  }

  return total;
}

const meanOf = (marks: Marked[], part: keyof StatParts): number =>
  marks.reduce((sum, m) => sum + m.was[part], 0) / Math.max(1, marks.length);

/** the parts this group of players records often enough to be scored on */
function countedParts(marks: Marked[]): (keyof StatParts)[] {
  const biggest = Math.max(...PART_NAMES.map((part) => meanOf(marks, part)));

  return PART_NAMES.filter(
    (part) => meanOf(marks, part) >= biggest * TOO_SMALL_SHARE,
  );
}

/** the scaled line error, and the parts it was averaged over */
function lineError(
  marks: Marked[],
  reader: string,
): { score: number; parts: number } {
  const parts = countedParts(marks);
  let total = 0;

  for (const part of parts) {
    total += partError(marks, reader, part) / meanOf(marks, part);
  }

  return {
    score: parts.length === 0 ? 0 : total / parts.length,
    parts: parts.length,
  };
}

function partError(marks: Marked[], reader: string, part: keyof StatParts): number {
  return (
    marks.reduce(
      (sum, m) => sum + Math.abs(m.said[reader]![part] - m.was[part]),
      0,
    ) / marks.length
  );
}

async function roleFitFor(season: number): Promise<InSeasonFit> {
  const rows: RoleLevelRow[] = [];

  for (let year = season - ROLE_SEASONS; year < season; year++) {
    rows.push(...roleRowsFrom(await readPlayedWeeks(year)));
  }

  return { role: fitRoleLevel(rows), shape: SHIPPED_SHAPE };
}

async function main(): Promise<void> {
  const years = seasons(FIRST_DATA, LAST_PLAYED);
  const data = await buildSeasonData(years);
  await loadGames();
  const examples = new Map<number, SeasonExample[]>();

  for (const year of seasons(FIRST_TRANSITION, LAST_PLAYED)) {
    examples.set(year, await examplesForTransition(year, data));
  }

  const marked = new Map<number, Marked[]>(CUTS.map((cut) => [cut, []]));

  for (const season of MARKED) {
    const train: SeasonExample[] = [];

    for (const year of seasons(FIRST_TRANSITION, season - 1)) {
      train.push(...examples.get(year)!);
    }

    const fit = fitSeasonModel(train);
    const partsFit = fitPartsModel(train);
    const floors = partsByPosition(train);
    const roleFit = await roleFitFor(season);
    const read = await readPlayedWeeks(season);
    const stats = (await loadPlayerStats(season)).filter((r) => r.week <= 18);
    const byPlayer = new Map<string, typeof stats>();

    for (const row of stats) {
      const his = byPlayer.get(row.playerId) ?? [];
      his.push(row);
      byPlayer.set(row.playerId, his);
    }

    for (const e of examples.get(season)!) {
      if (!POSITIONS.includes(e.position)) {
        continue;
      }

      const anchorPpg = predictSeasonBlend(fit, e);
      const anchorParts = predictParts(partsFit, e, floors);
      const his = read.weeks.get(e.playerId) ?? [];
      const rows = byPlayer.get(e.playerId) ?? [];

      for (const cut of CUTS) {
        const before = his.filter((w) => w.week <= cut);
        const after = rows.filter((r) => r.week > cut);

        if (before.length === 0 || after.length < MIN_REST_GAMES ||
          anchorPpg <= 0) {
          continue;
        }

        const level = updateLevel(roleFit, {
          anchor: anchorPpg,
          position: e.position,
          weeks: before,
        });
        const ratio = level.ppg / anchorPpg;
        const scaled = blankParts();

        for (const part of PART_NAMES) {
          scaled[part] = anchorParts[part] * ratio;
        }

        marked.get(cut)!.push({
          position: e.position,
          was: perGame(after),
          said: {
            [TODAY]: anchorParts,
            [SCALED]: scaled,
            [USAGE_LED]: updateParts({
              anchor: anchorParts,
              observed: summarizeWindow(before, roleFit.shape).usage,
              fromSeason: level.weightOnRole + level.weightOnPoints,
              levelRatio: ratio,
            }),
            [TO_DATE]: perGame(rows.filter((r) => r.week <= cut)),
            [ORACLE]: perGame(after),
          },
        });
      }
    }

    console.log(`${season}: ${read.weeks.size} players played`);
  }

  for (const cut of CUTS) {
    const marks = marked.get(cut)!;
    console.log(`\nafter week ${cut}: ${marks.length} player cuts`);
    console.log("".padEnd(32) + "all   QB    RB    WR    TE");

    for (const reader of READERS) {
      const cells = POSITIONS.map((position) => {
        const his = marks.filter((m) => m.position === position);

        return lineError(his, reader).score.toFixed(3);
      });
      console.log(
        `${reader.padEnd(32)}${lineError(marks, reader).score.toFixed(3)} ` +
        cells.map((c) => c.padStart(5)).join(" "),
      );
    }

    if (process.argv.includes("--detail")) {
      for (const position of POSITIONS) {
        const his = marks.filter((m) => m.position === position);
        const parts = countedParts(his);
        console.log(`  ${position}, scaled error part by part`);
        console.log("".padEnd(32) + parts.map((p) => p.padStart(8)).join(""));

        for (const reader of READERS) {
          const cells = parts.map((part) =>
            (partError(his, reader, part) / meanOf(his, part))
              .toFixed(2).padStart(8));
          console.log(`${reader.padEnd(32)}${cells.join("")}`);
        }
      }
    }

    const catchers = marks.filter((m) => m.position !== "QB");
    console.log("  pass catchers, points a game aside:");
    console.log(
      "".padEnd(32) + "targets  catches  rec yds  rec TD",
    );

    for (const reader of READERS) {
      const cells: (keyof StatParts)[] = ["targets", "receptions", "recYds", "recTd"];
      console.log(
        `${reader.padEnd(32)}` +
        cells
          .map((part) => partError(catchers, reader, part).toFixed(2).padStart(7))
          .join("  "),
      );
    }
  }
}

await main();

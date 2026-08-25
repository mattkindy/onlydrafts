/**
 * Does the share model belong on the draft board?
 *
 * The board orders players by the season regression and then mixes
 * that order half and half with where adp had them. The
 * share model was built and measured separately and never wired in.
 * This asks whether adding it to the mix beats the board as it
 * is, on the men the market actually priced. Everything is out of
 * sample: the regression trains on earlier seasons and who is on
 * which team comes from the target season's opening roster.
 *
 * Run: npx tsx scripts/boardShareEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman, caught, gain } from "../src/backtest/metrics.js";

/**
 * Three rounds of a twelve team draft. Wider than this and every order
 * scores the same, because the pool priced by adp is barely bigger than
 * the number taken, so taking the top of it takes all of it.
 */
const FIRST_FEW = 36;
import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
  projectDraftExamples,
  type SeasonExample,
} from "../src/features/seasonModel.js";
import {
  experienceBefore,
  pastShares,
  projectShares,
  projectSplitShares,
  SHARING_POSITIONS,
  type RosterMan,
} from "../src/features/projectedShares.js";

const RULES = presets.standard;
const ALL_SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const TEST_SEASONS = [2023, 2024, 2025];
const MIN_GAMES = 4;

/** how many plays each offence ran, by season and team */
async function playCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (!["run", "pass"].includes(row["playType"] ?? "")) {
      continue;
    }

    const key = `${row["season"]}|${row["offense"]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

/** who was on each roster in the opening week, which a drafter knows */
async function openingRoster(season: number): Promise<RosterMan[]> {
  const seen = new Map<string, RosterMan>();

  for (const row of await loadWeeklyRosters(season)) {
    if (row.week > 1 || seen.has(row.playerId)) {
      continue;
    }

    if (!SHARING_POSITIONS.includes(row.rawPosition)) {
      continue;
    }

    seen.set(row.playerId, {
      playerId: row.playerId, position: row.rawPosition, team: row.teamId,
    });
  }

  return [...seen.values()];
}

/** places, best first, so two orderings can be averaged */
function placeOf(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const out = new Array<number>(values.length);
  order.forEach((row, rank) => { out[row.i] = rank + 1; });

  return out;
}

/**
 * How many of each position a twelve-team league starts, which is
 * what makes a position scarce and therefore what a board is ordered
 * on. A back is only worth more than a receiver by however much he
 * beats the back you could have had for nothing.
 */
const STARTED = { QB: 12, RB: 34, WR: 26, TE: 12 } as Record<string, number>;

interface Row {
  name: string;
  position: string;
  adp: number;
  model: number;
  /** what the played-out games say he scores, absent if they never saw him */
  walked: number | null;
  touches: number;
  /** those targets at what his own depth is worth a target */
  atHisDepth: number;
  /** those touches at what his position scores on one */
  atPosition: number;
  /** and at what he himself has scored on one */
  atHisOwn: number;
  points: number;
  /** those points less what the last startable man at his position scored */
  overReplacement: number;
  games: number;
}

/**
 * What a touch has been worth to him, pulled toward his position.
 *
 * A back and a receiver do not score the same on a touch, so ordering
 * the two together by touches alone puts every back above every
 * receiver. A man's own rate says more than that, and it is noisy on
 * few touches, so it is pulled toward what his position does.
 */
function perTouch(
  own: { points: number; touches: number } | undefined,
  position: number,
  steadyAt = 150,
): number {
  if (!own || own.touches <= 0) {
    return position;
  }

  const trust = own.touches / (own.touches + steadyAt);

  return trust * (own.points / own.touches) + (1 - trust) * position;
}

async function rowsFor(
  season: number,
  data: Awaited<ReturnType<typeof buildSeasonData>>,
  plays: Map<string, number>,
  picks: Awaited<ReturnType<typeof loadDraftPicks>>,
): Promise<Row[]> {
  const train: SeasonExample[] = [];

  for (const t of ALL_SEASONS.filter((s) => s >= 2017 && s < season)) {
    train.push(...(await examplesForTransition(t, data)));
  }

  const fit = fitSeasonModel(train);
  const projected = await projectDraftExamples(season, data);
  const roster = await openingRoster(season);
  const past = await pastShares(
    [season - 3, season - 2, season - 1],
    (s, team) => plays.get(`${s}|${team}`) ?? 1000,
  );
  const experience = await experienceBefore(season);
  const shares = projectShares({ season, roster, past, picks, experience });
  const split = projectSplitShares({ season, roster, past, picks, experience });
  const teamOf = new Map(roster.map((man) => [man.playerId, man.team]));
  const adp = await loadAdp(season);
  const scored = new Map<string, number>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18) {
      continue;
    }

    scored.set(
      s.playerId, (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  /**
   * What a target is worth at each depth, and how deep each man is
   * thrown.
   *
   * How far downfield a man is thrown carries to the next season at
   * .877, the surest thing known about a player, and it sets what a
   * target is worth: a checkdown makes five yards and a shot past
   * twenty-five makes thirteen. So volume from the share model and
   * depth from the man should say more together than either alone.
   */
  const depthOf = new Map<string, { targets: number; depth: number }>();
  const worthAt = new Map<number, { throws: number; yards: number }>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ))) {
    const at = Number(row["season"]);

    if (at >= season || at < season - 3 || row["playType"] !== "pass") {
      continue;
    }

    const air = Number(row["airYards"]);
    const yards = Number(row["yards"]) || 0;

    if (!Number.isFinite(air)) {
      continue;
    }

    const band = Math.min(5, Math.max(0, Math.floor((air + 5) / 7)));
    const seen = worthAt.get(band) ?? { throws: 0, yards: 0 };
    seen.throws++;
    seen.yards += yards;
    worthAt.set(band, seen);

    if (row["player"]) {
      const his = depthOf.get(row["player"]!) ?? { targets: 0, depth: 0 };
      his.targets++;
      his.depth += air;
      depthOf.set(row["player"]!, his);
    }
  }

  const perTargetAt = (air: number) => {
    const band = Math.min(5, Math.max(0, Math.floor((air + 5) / 7)));
    const seen = worthAt.get(band);

    return seen && seen.throws > 20 ? seen.yards / seen.throws : 6.5;
  };

  // what a touch has been worth, from the seasons before this one
  const before = new Map<string, { points: number; touches: number }>();
  const byPosition = new Map<string, { points: number; touches: number }>();

  for (const s of [season - 3, season - 2, season - 1]) {
    for (const row of await loadPlayerStats(s)) {
      if (row.week > 18 || !SHARING_POSITIONS.includes(row.position)) {
        continue;
      }

      const got = fantasyPoints(row.statLine, RULES);
      const had = row.carries + row.targets;
      const own = before.get(row.playerId) ?? { points: 0, touches: 0 };
      own.points += got;
      own.touches += had;
      before.set(row.playerId, own);

      const group = byPosition.get(row.position) ?? { points: 0, touches: 0 };
      group.points += got;
      group.touches += had;
      byPosition.set(row.position, group);
    }
  }

  // what the last startable man at each position scored, so a season
  // can be judged the way a board is ordered
  const scoredAt = new Map<string, number[]>();
  const positionOf = new Map<string, string>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week <= 18) {
      positionOf.set(s.playerId, s.position);
    }
  }

  for (const [playerId, points] of scored) {
    const position = positionOf.get(playerId) ?? "";
    scoredAt.set(position, [...(scoredAt.get(position) ?? []), points]);
  }

  const replacementAt = new Map<string, number>();

  for (const [position, points] of scoredAt) {
    const sorted = [...points].sort((a, b) => b - a);
    const last = STARTED[position] ?? sorted.length;
    replacementAt.set(position, sorted[Math.min(last, sorted.length) - 1] ?? 0);
  }

  // what the played out games said, kept from the simulation runs
  const walkFile = JSON.parse(await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${season}.json`),
    "utf8",
  ).catch(() => '{"total":[]}')) as { total: [string, number][] };
  const walkSays = new Map<string, number>(walkFile.total);

  const rows: Row[] = [];

  for (const e of projected) {
    if (!SHARING_POSITIONS.includes(e.position)) {
      continue;
    }

    const name = data.get(season - 1)?.summaries.get(e.playerId)?.playerName;
    const entry = name ? adp.get(`${normalizeName(name)}|${e.position}`) : undefined;
    const games = played.get(e.playerId) ?? 0;

    if (!entry || games < MIN_GAMES) {
      continue;
    }

    // a share is of his offence, so the size of that offence is what
    // turns it into the touches he actually gets
    const ran = plays.get(`${season - 1}|${teamOf.get(e.playerId)}`) ?? 1000;
    const touches = (shares.get(e.playerId) ?? 0) * ran;
    const group = byPosition.get(e.position);
    const perGroupTouch = group && group.touches > 0
      ? group.points / group.touches
      : 1;

    rows.push({
      name: name!,
      position: e.position,
      adp: entry.adp,
      model: predictSeasonBlend(fit, e),
      touches,
      atHisDepth: (() => {
        const halves = split.get(e.playerId);

        if (!halves) {
          return touches * perGroupTouch;
        }

        // his carries at what a carry makes, and his targets at what
        // a target makes when it goes as far as his usually do
        const his = depthOf.get(e.playerId);
        const perTarget = his && his.targets >= 20
          ? perTargetAt(his.depth / his.targets)
          : 6.5;

        return halves.carries * ran * 4.4 + halves.targets * ran * perTarget;
      })(),
      walked: walkSays.get(e.playerId) ?? null,
      atPosition: touches * perGroupTouch,
      atHisOwn: touches * perTouch(before.get(e.playerId), perGroupTouch),
      points: scored.get(e.playerId) ?? 0,
      overReplacement:
        (scored.get(e.playerId) ?? 0) - (replacementAt.get(e.position) ?? 0),
      games,
    });
  }

  return rows;
}

async function main(): Promise<void> {
  const data = await buildSeasonData(ALL_SEASONS);
  const plays = await playCounts();
  const picks = await loadDraftPicks();
  // two ways of being right: who scored the most, and who was worth
  // the most over the man you could have had at his position instead
  const onPoints = new Map<string, number[]>();
  const onValue = new Map<string, number[]>();
  const onCaught = new Map<string, number[]>();
  const onGain = new Map<string, number[]>();

  for (const season of TEST_SEASONS) {
    const rows = await rowsFor(season, data, plays, picks);
    const byAdp = placeOf(rows.map((r) => -r.adp));
    const model = placeOf(rows.map((r) => r.model));
    const share = placeOf(rows.map((r) => r.touches));
    const byGroup = placeOf(rows.map((r) => r.atPosition));
    const byOwn = placeOf(rows.map((r) => r.atHisOwn));
    const byDepth = placeOf(rows.map((r) => r.atHisDepth));
    /**
     * A man the simulation never saw keeps his regression place in
     * its vote, the way the board treats any silent opinion, rather
     * than being ranked last for the crime of being missing.
     */
    const seen = rows
      .map((r, i) => ({ i, walked: r.walked }))
      .filter((r) => r.walked !== null);
    const seenPlace = placeOf(seen.map((r) => r.walked!));
    const walk = [...model];
    seen.forEach((r, k) => { walk[r.i] = seenPlace[k]!; });

    for (const [truth, into, judge] of [
      [rows.map((r) => r.points), onPoints, spearman],
      [rows.map((r) => r.overReplacement), onValue, spearman],
      // the same order asked what a drafter got out of it, where a
      // mistake at pick three counts and one at pick a hundred and
      // sixty does not
      [rows.map((r) => r.overReplacement), onCaught,
        (said: number[], was: number[]) => caught(said, was, FIRST_FEW)],
      [rows.map((r) => r.overReplacement), onGain, gain],
    ] as [number[], Map<string, number[]>, (a: number[], b: number[]) => number][]) {
      const note = (label: string, value: number) =>
        into.set(label, [...(into.get(label) ?? []), value]);
      const alone = (places: number[]) => judge(places.map((r) => -r), truth);
      const mix = (parts: number[][], weights: number[]) =>
        judge(
          parts[0]!.map((_, i) =>
            -parts.reduce((sum, part, k) => sum + weights[k]! * part[i]!, 0),
          ),
          truth,
        );

      note("where adp had him", alone(byAdp));
      note("the season regression", alone(model));
      note("the share model, in touches", alone(share));
      note("touches at his position's points", alone(byGroup));
      note("touches at his own points", alone(byOwn));
      note("his carries and his targets, each at what they make", alone(byDepth));
      note("the played out games, silent men at their regression", alone(walk));

      /**
       * The walk as a minority voice on top of the blend that already
       * works, which is the bar the other members met: nobody in the
       * mix beats adp alone.
       */
      const keeps = { adp: 0.3, share: 0.525, model: 0.175 };

      for (const onWalk of [0, 0.05, 0.1, 0.15, 0.2, 0.3]) {
        const scale = 1 - onWalk;
        note(
          `the board's blend with the walk at ${(100 * onWalk).toFixed(0)}%`,
          mix(
            [walk, byAdp, share, model],
            [onWalk, keeps.adp * scale, keeps.share * scale, keeps.model * scale],
          ),
        );
      }
      note("regression and adp, the board today", mix([model, byAdp], [0.5, 0.5]));

      /**
       * What the regression's own seat is worth.
       *
       * The board gives it .106 and a man can be first on our own
       * numbers and second on the board, which is what prompted this.
       * The walk keeps its .15 and the rest of the room divides what is
       * left in the ratio it has now, so only the regression's share
       * moves.
       */
      for (const onModel of [0.106, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
        const rest = 1 - onModel - 0.15;
        const shareOf = 0.319 / (0.319 + 0.425);
        note(
          `the blend with the regression at ${(100 * onModel).toFixed(0)}%`,
          mix(
            [model, share, byAdp, walk],
            [onModel, rest * shareOf, rest * (1 - shareOf), 0.15],
          ),
        );
      }

      // and the whole grid for each way of voting, so the weighting
      // is picked off a plateau rather than off a peak
      for (const [how, vote] of [
        ["touches", share], ["split by depth", byDepth],
      ] as [string, number[]][]) {
        for (const onAdp of [0.3, 0.4, 0.5, 0.6]) {
          for (const ofRest of [0.25, 0.5, 0.75, 1]) {
            const rest = 1 - onAdp;
            note(
              `${how.padEnd(11)} adp ${(100 * onAdp).toFixed(0)}%, ` +
                `share ${(100 * ofRest).toFixed(0)}% of the rest`,
              mix([model, vote, byAdp], [rest * (1 - ofRest), rest * ofRest, onAdp]),
            );
          }
        }
      }
    }

    console.log(`${season}: ${rows.length} men adp priced`);
  }

  const report = (what: string, ways: Map<string, number[]>) => {
    console.log(
      `\nordering ${what}, higher is better\n` +
        `averaged over ${TEST_SEASONS.join(", ")}\n`,
    );

    for (const [label, seasons] of ways) {
      const mean = seasons.reduce((a, b) => a + b, 0) / seasons.length;
      console.log(
        "  " + label.padEnd(40) + mean.toFixed(4).padStart(7) +
          "   " + seasons.map((s) => s.toFixed(3)).join(" "),
      );
    }
  };

  report("a season's fantasy points", onPoints);
  report("points over the last startable man at his position", onValue);
  report(
    `the share of the value in the first ${FIRST_FEW} picks it collected`,
    onCaught,
  );
  report("the same with every place worth less than the one above", onGain);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

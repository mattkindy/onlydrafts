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
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { fitJoint, noParts, type Parts } from "../src/features/jointParts.js";
import { partsIn } from "../src/data/advancedParts.js";

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
/**
 * The seasons to mark on. Widen it with SEASONS=2021,2022,2023,2024,2025
 * to put more behind the numbers, remembering the walk has only been
 * run for 2023 on, so its row goes quiet for anything earlier.
 */
const TEST_SEASONS = (process.env["SEASONS"] ?? "2023,2024,2025")
  .split(",").map(Number);
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

/**
 * Places, best first, leaving out anyone this opinion cannot see, then
 * moved onto the whole field's scale the way the board does it. An
 * opinion that only speaks for half the men numbers them 1 to half,
 * and adding that to one that numbered everybody pulls its men
 * forward.
 */
function placeOf(values: (number | null)[]): (number | undefined)[] {
  const seen = values
    .map((v, i) => ({ v, i }))
    .filter((r): r is { v: number; i: number } => r.v !== null);
  const order = [...seen].sort((a, b) => b.v - a.v);
  // filled rather than left with holes, since map skips a hole and
  // hands the next thing along an array shorter than it expects
  const out = new Array<number | undefined>(values.length).fill(undefined);

  // the places on the whole field that this opinion's men occupy
  const sittingAt = seen.map((r) => r.i).sort((a, b) => a - b);
  order.forEach((row, rank) => { out[row.i] = sittingAt[rank]! + 1; });

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
  playerId: string;
  name: string;
  position: string;
  /** where the market has him, absent for a man nobody is taking */
  adp: number | null;
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
  /** a man with no season behind him, priced by his draft slot */
  rookie?: boolean;
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

    // men nobody priced belong here too. Leaving them out was why
    // this bench could not see an opinion go quiet, and an ordering
    // that put an undrafted quarterback ninth scored well on it.
    if (!name || games < MIN_GAMES) {
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
      name,
      position: e.position,
      adp: entry ? entry.adp : null,
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
      playerId: e.playerId,
      points: scored.get(e.playerId) ?? 0,
      overReplacement:
        (scored.get(e.playerId) ?? 0) - (replacementAt.get(e.position) ?? 0),
      games,
    });
  }

  /**
   * The drafted rookies, who have no season behind them and so no
   * example above. Leaving them out was why the bench carried two
   * rookies a season where the board carries twenty, and why the
   * silences that fall on rookies could not be measured. Their model
   * column is what their draft slot has been worth, fitted on the
   * rookies of the seasons before this one.
   */
  const namesOn = new Map<string, string>();

  for (const row of await loadWeeklyRosters(season)) {
    if (row.week === 1) {
      namesOn.set(row.playerId, row.name);
    }
  }

  const slotPicks = await loadDraftPicks(
    ALL_SEASONS.filter((s) => s < season),
  );
  const slotRows: number[][] = [];
  const slotPpg: number[] = [];

  for (const p of slotPicks.values()) {
    const his = data.get(p.season)?.summaries.get(p.playerId);

    if (!his || his.games < MIN_GAMES ||
        !SHARING_POSITIONS.concat("QB").includes(p.position)) {
      continue;
    }

    slotRows.push([
      1, Math.log(p.pick) / Math.log(260),
      p.position === "RB" ? 1 : 0, p.position === "WR" ? 1 : 0,
      p.position === "QB" ? 1 : 0,
    ]);
    slotPpg.push(his.pointsPerGame);
  }

  const slotFit = slotRows.length >= 60
    ? fitRidge(slotRows, slotPpg, 0.5)
    : undefined;
  const itsRookies = await loadDraftPicks([season]);

  for (const p of itsRookies.values()) {
    if (p.season !== season || !SHARING_POSITIONS.includes(p.position) ||
        rows.some((r) => r.playerId === p.playerId)) {
      continue;
    }

    const games = played.get(p.playerId) ?? 0;
    const name = namesOn.get(p.playerId);

    if (!name || games < MIN_GAMES || !slotFit) {
      continue;
    }

    const entry = adp.get(`${normalizeName(name)}|${p.position}`);
    const ran = plays.get(`${season - 1}|${p.team}`) ?? 1000;
    const touches = (shares.get(p.playerId) ?? 0) * ran;
    const group = byPosition.get(p.position);
    const perGroupTouch = group && group.touches > 0
      ? group.points / group.touches
      : 1;
    const saidPpg = Math.max(0, predictRidge(slotFit, [
      1, Math.log(p.pick) / Math.log(260),
      p.position === "RB" ? 1 : 0, p.position === "WR" ? 1 : 0, 0,
    ]));

    rows.push({
      name,
      position: p.position,
      adp: entry ? entry.adp : null,
      model: saidPpg * 16,
      touches,
      atHisDepth: touches * perGroupTouch,
      walked: walkSays.get(p.playerId) ?? null,
      atPosition: touches * perGroupTouch,
      atHisOwn: touches * perGroupTouch,
      playerId: p.playerId,
      points: scored.get(p.playerId) ?? 0,
      overReplacement:
        (scored.get(p.playerId) ?? 0) - (replacementAt.get(p.position) ?? 0),
      games,
      rookie: true,
    });
  }

  return rows;
}

/**
 * The joint model over a man's parts, taught on the seasons before the
 * first one being marked so it never sees an answer it is asked for.
 */
async function scoredIn(season: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week <= 18) {
      out.set(s.playerId, (out.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES));
    }
  }

  return out;
}

async function learnJoint(before: number) {
  const first = before;
  const learn: { parts: Parts; position: string; scored: number }[] = [];
  const positionsIn = new Map<string, string>();

  for (const season of ALL_SEASONS) {
    for (const s of await loadPlayerStats(season)) {
      positionsIn.set(s.playerId, s.position);
    }
  }

  for (const season of ALL_SEASONS) {
    if (season + 1 >= first) {
      continue;
    }

    const parts = await partsIn(season);
    const after = await scoredIn(season + 1);
    const played = new Map<string, number>();

    for (const s of await loadPlayerStats(season + 1)) {
      played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
    }

    for (const [who, his] of parts) {
      const games = played.get(who) ?? 0;

      if (games < 6 || his.games < 4) {
        continue;
      }

      learn.push({
        parts: his,
        position: positionsIn.get(who) ?? "WR",
        scored: (after.get(who) ?? 0) / games,
      });
    }
  }

  return { fitted: fitJoint(learn), learnedOn: learn.length };
}

async function main(): Promise<void> {
  const data = await buildSeasonData(ALL_SEASONS);
  const plays = await playCounts();
  const picks = await loadDraftPicks();
  // one fit per season it is marked on, taught only on pairs that had
  // finished by then, so it never sees a season it is asked about
  const jointFor = new Map<number, Awaited<ReturnType<typeof learnJoint>>>();

  for (const season of TEST_SEASONS) {
    jointFor.set(season, await learnJoint(season));
    console.log(
      `for ${season} the joint model learned on ` +
      `${jointFor.get(season)!.learnedOn} seasons of men`,
    );
  }

  console.log("");
  // two ways of being right: who scored the most, and who was worth
  // the most over the man you could have had at his position instead
  const onPoints = new Map<string, number[]>();
  const onValue = new Map<string, number[]>();
  const onCaught = new Map<string, number[]>();
  // the same mark taken deeper, to see where an opinion earns its place
  const deeper: [number, Map<string, number[]>][] =
    [72, 120, 200].map((cut) => [cut, new Map<string, number[]>()]);
  const onGain = new Map<string, number[]>();

  for (const season of TEST_SEASONS) {
    const rows = await rowsFor(season, data, plays, picks);
    // his parts from the season before, which is what a drafter has
    const hisParts = await partsIn(season - 1);
    /**
     * A man the advanced files never saw keeps his regression place,
     * the same courtesy the walk gets, rather than being ranked last
     * for being missing.
     */
    const jointSays = rows.map((r) => {
      const his = hisParts.get(r.playerId);

      return his ? jointFor.get(season)!.fitted.says(his, r.position) : null;
    });
    const jointPlaces = placeOf(jointSays);
    const priced = rows.filter((r) => r.adp !== null).length;
    console.log(
      `  ${season}: ${rows.length} men, ${priced} of them priced by adp, ` +
      `${jointSays.filter((s) => s !== null).length} with parts behind them`,
    );
    const byAdp = placeOf(rows.map((r) => (r.adp === null ? null : -r.adp)));
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
    seen.forEach((r, k) => { walk[r.i] = seenPlace[k]; });

    for (const [truth, into, judge] of [
      [rows.map((r) => r.points), onPoints, spearman],
      [rows.map((r) => r.overReplacement), onValue, spearman],
      // the same order asked what a drafter got out of it, where a
      // mistake at pick three counts and one at pick a hundred and
      // sixty does not
      [rows.map((r) => r.overReplacement), onCaught,
        (said: number[], was: number[]) => caught(said, was, FIRST_FEW)],
      [rows.map((r) => r.overReplacement), onGain, gain],
      ...deeper.map(([cut, table]) => [
        rows.map((r) => r.overReplacement), table,
        (said: number[], was: number[]) => caught(said, was, cut),
      ]),
    ] as [number[], Map<string, number[]>, (a: number[], b: number[]) => number][]) {
      const note = (label: string, value: number) =>
        into.set(label, [...(into.get(label) ?? []), value]);
      /**
       * A man an opinion cannot see goes to the back of its list, and
       * in a mix its weight goes to the opinions that did speak. This
       * is what blendedPlace does on the board, and the bench used to
       * assume every opinion spoke for everybody.
       */
      const backOfTheField = rows.length + 1;
      const alone = (places: (number | undefined)[]) =>
        judge(places.map((r) => -(r ?? backOfTheField)), truth);
      const mix = (parts: (number | undefined)[][], weights: number[]) =>
        judge(
          rows.map((_, i) => {
            let said = 0;
            let spoke = 0;

            parts.forEach((part, k) => {
              if (part[i] !== undefined) {
                said += weights[k]! * part[i]!;
                spoke += weights[k]!;
              }
            });

            return spoke > 0 ? -(said / spoke) : -backOfTheField;
          }),
          truth,
        );

      /**
       * The walk counting for more the further down the board a man
       * is. It is flat at the top and grows with depth, so one weight
       * for the whole board is either too much early or too little
       * late.
       *
       * Where he is has to come from somewhere, and it cannot come
       * from the answer, so this blends once at the flat weight and
       * uses that to decide how much walk he gets on the second pass.
       */
      const ramped = (top: number, bottom: number, reaches: number) => {
        const firstPass = rows.map((_, i) => {
          let said = 0;
          let spoke = 0;

          [[model, 0.106], [share, 0.319], [byAdp, 0.425], [walk, 0.15]]
            .forEach(([part, w]) => {
              const place = (part as (number | undefined)[])[i];

              if (place !== undefined) {
                said += (w as number) * place;
                spoke += w as number;
              }
            });

          return spoke > 0 ? said / spoke : rows.length + 1;
        });

        return judge(
          rows.map((_, i) => {
            const howFar = Math.min(1, (firstPass[i]! - 1) / reaches);
            const onWalk = top + (bottom - top) * howFar;
            const scale = 1 - onWalk;
            let said = 0;
            let spoke = 0;

            [[model, 0.106 * scale], [share, 0.319 * scale],
             [byAdp, 0.425 * scale], [walk, onWalk]]
              .forEach(([part, w]) => {
                const place = (part as (number | undefined)[])[i];

                if (place !== undefined) {
                  said += (w as number) * place;
                  spoke += w as number;
                }
              });

            return spoke > 0 ? -(said / spoke) : -(rows.length + 1);
          }),
          truth,
        );
      };

      note("the walk growing 15% to 30% by pick 150", ramped(0.15, 0.30, 150));
      note("the walk growing 15% to 40% by pick 150", ramped(0.15, 0.40, 150));
      note("the walk growing 10% to 35% by pick 100", ramped(0.10, 0.35, 100));

      // where on the board the walk is worth having, since the sharp
      // end and the body of it want different amounts of it
      for (const onWalk of [0, 0.15, 0.3]) {
        const scale = 1 - onWalk;
        note(
          `walk ${(100 * onWalk).toFixed(0)}%`,
          mix([model, share, byAdp, walk],
            [0.106 * scale, 0.319 * scale, 0.425 * scale, onWalk]),
        );
      }

      /**
       * Nobody pricing a man is itself a strong thing to know, and the
       * blend throws it away: an opinion with nothing to say hands its
       * weight to the others, so a man the market has never heard of
       * is ordered as though the question never came up. This asks
       * what he is worth if being unpriced counts against him.
       */
      const unpriced = rows.map((r) => r.adp === null);
      const shy = (places: (number | undefined)[], howFar: number) =>
        judge(
          places.map((p, i) => {
            const place = p ?? backOfTheField;

            return -(unpriced[i] ? place + howFar : place);
          }),
          truth,
        );
      const boardPlaces = rows.map((_, i) => {
        let said = 0;
        let spoke = 0;

        [[model, 0.106], [share, 0.319], [byAdp, 0.425], [walk, 0.15]]
          .forEach(([part, w]) => {
            const place = (part as (number | undefined)[])[i];

            if (place !== undefined) {
              said += (w as number) * place;
              spoke += w as number;
            }
          });

        return spoke > 0 ? said / spoke : backOfTheField;
      });

      note("the board as it is", shy(boardPlaces, 0));

      for (const howFar of [20, 50, 100]) {
        note(`the board, unpriced men set back ${howFar}`, shy(boardPlaces, howFar));
      }

      /**
       * The rookies with their draft slot filling the seat the parts
       * model leaves empty for them, since a man with no season still
       * has a price the market paid for him in April.
       */
      const slotFilled = placeOf(rows.map((r, i) =>
        jointSays[i] ?? (r.rookie ? r.model / 16 : null)));
      const slotBoard = rows.map((_, i) => {
        let said = 0;
        let spoke = 0;

        [[slotFilled, 0.106], [share, 0.319], [byAdp, 0.425], [walk, 0.15]]
          .forEach(([part, w]) => {
            const place = (part as (number | undefined)[])[i];

            if (place !== undefined) {
              said += (w as number) * place;
              spoke += w as number;
            }
          });

        return spoke > 0 ? said / spoke : backOfTheField;
      });

      note("set back 100, rookies at their slot", shy(slotBoard, 100));

      // the shipped rookies-at-slot seat with the walk's weight raised,
      // which the sweeps below never combined
      for (const onWalk of [0.2, 0.25, 0.3]) {
        const scale = (1 - onWalk) / (1 - 0.15);
        const raised = rows.map((_, i) => {
          let said = 0;
          let spoke = 0;

          ([[slotFilled, 0.106 * scale], [share, 0.319 * scale],
            [byAdp, 0.425 * scale], [walk, onWalk]] as
            [(number | undefined)[], number][])
            .forEach(([part, w]) => {
              const place = part[i];

              if (place !== undefined) {
                said += w * place;
                spoke += w;
              }
            });

          return spoke > 0 ? said / spoke : backOfTheField;
        });
        note(
          `rookies at slot, walk at ${(100 * onWalk).toFixed(0)}%`,
          shy(raised, 100),
        );
      }

      // the walk got better this week, so its seat is asked again with
      // the set back on, which the earlier sweep never combined
      for (const onWalk of [0.15, 0.25, 0.35, 0.5]) {
        const scale = (1 - onWalk) / (1 - 0.15);
        const placesAt = rows.map((_, i) => {
          let said = 0;
          let spoke = 0;

          [[model, 0.106 * scale], [share, 0.319 * scale],
           [byAdp, 0.425 * scale], [walk, onWalk]]
            .forEach(([part, w]) => {
              const place = (part as (number | undefined)[])[i];

              if (place !== undefined) {
                said += (w as number) * place;
                spoke += w as number;
              }
            });

          return spoke > 0 ? said / spoke : backOfTheField;
        });
        note(`set back 100, walk at ${(100 * onWalk).toFixed(0)}%`,
          shy(placesAt, 100));
      }

      /**
       * The other two silences. The walk not seeing a man means he was
       * not on a roster it played, and his parts being missing means he
       * has never had a season. Both might be saying something about
       * him the way adp's silence was, or might be saying nothing.
       */
      const setBack = (
        which: (i: number) => boolean, howFar: number, alsoUnpriced: number,
      ) =>
        judge(
          boardPlaces.map((place, i) =>
            -(place + (unpriced[i] ? alsoUnpriced : 0) + (which(i) ? howFar : 0))),
          truth,
        );
      const noWalk = (i: number) => walk[i] === undefined;
      const noParts = (i: number) => jointPlaces[i] === undefined;

      if (into === onValue) {
        console.log(
          `    of ${rows.length}: ${rows.filter((_, i) => unpriced[i]).length} unpriced, ` +
          `${rows.filter((_, i) => noWalk(i)).length} the walk never saw, ` +
          `${rows.filter((_, i) => noParts(i)).length} with no season`,
        );
      }

      for (const howFar of [20, 50]) {
        note(`and men the walk never saw back ${howFar}`, setBack(noWalk, howFar, 100));
        note(`and men with no season back ${howFar}`, setBack(noParts, howFar, 100));
      }

      note("where adp had him", alone(byAdp));
      note("the season regression", alone(model));
      note("one model over all his parts", alone(jointPlaces));
      note("that and adp, half each",
        mix([jointPlaces, byAdp], [0.5, 0.5]));
      note("the board's blend with his parts at 15%",
        mix([model, share, byAdp, jointPlaces], [0.09, 0.27, 0.49, 0.15]));
      // it beats the regression on its own, so give it that seat
      // rather than a new one
      note("his parts in the regression's seat",
        mix([jointPlaces, share, byAdp, walk], [0.106, 0.319, 0.425, 0.15]));
      note("his parts in the regression's seat, at 20%",
        mix([jointPlaces, share, byAdp, walk], [0.20, 0.28, 0.37, 0.15]));
      note("his parts and the regression sharing it",
        mix([model, jointPlaces, share, byAdp, walk],
          [0.053, 0.053, 0.319, 0.425, 0.15]));
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

  for (const [cut, table] of deeper) {
    report(`the same over the first ${cut} picks`, table);
  }
  report("the same with every place worth less than the one above", onGain);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

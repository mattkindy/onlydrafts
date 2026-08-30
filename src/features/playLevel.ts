/**
 * How many yards this play should be worth, with everyone on it.
 *
 * The walk has been bending a draw by one multiplier at a time: the
 * man's own yards, then the two sides pooled, then the pairing from
 * the network. Each was fitted on its own and each could only see its
 * own term, so nothing could say that a defence costs a good receiver
 * more than a poor one, which it does, by half a yard a throw.
 *
 * Here one model sets the level with everybody on the row at once, and
 * the draw still comes from the situation pool, so the shape of the
 * yards is untouched and only the level is asked of the model.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import { loadCoaches } from "../data/coaches.js";
import { fitForest, predictForest, TREE_DEFAULTS, type Forest } from "../model/boostedTrees.js";
import { buildDefenceOnField, type DefenceOnField } from "./defenceOnField.js";
import type { Call, PlayState } from "../model/playFactors.js";

/** who is playing, beyond the two sides */
export interface PlaySides {
  offence?: string;
  defence?: string;
  /** who is throwing it, which the walk had no idea about */
  passer?: string;
  season?: number;
  week?: number;
}

export interface PlayLevel {
  /**
   * How much more or less often this play gains nothing at all than
   * an average cast would in the same spot.
   *
   * A third of throws gain exactly nothing because nobody caught
   * them, and that is most of what a defence does to an offence.
   * Scaling a drawn gain cannot touch it, since nothing times
   * anything is still nothing, so it is asked for separately and
   * moves which end of the pool the draw comes from.
   */
  /**
   * How often this call is a run here, with the two staffs and the
   * defence on the field in it, or nothing when the model cannot
   * say. A rate, not a leaning, since the pools answer the same
   * question and the caller decides how to mix them.
   */
  runsHere?: (state: PlayState, sides: PlaySides) => number | undefined;
  stuffedBy: (
    state: PlayState, call: Call, player: string, sides: PlaySides,
  ) => number;
  /** and what to multiply a gain by once it is one, near one */
  levelFor: (
    state: PlayState, call: Call, player: string, sides: PlaySides,
  ) => number;
  /** what the model thinks an average play is worth, per call */
  middleOn: (call: Call) => number;
  learnedOn: number;
}

export interface PlayLevelSettings {
  /** how far the level may move a play either way */
  most: number;
  trees: number;
  depth: number;
}

/**
 * The clamp is what the measurements support rather than what the
 * model will say. The men on a defence move a throw by about 1.3
 * yards out of 6.1, so a fifth, and a drive is a chain of plays where
 * a per-play error compounds into points.
 */
export const LEVEL_DEFAULTS: PlayLevelSettings = {
  most: Number(process.env["LEVEL_MOST"] ?? 0.15), trees: 150, depth: 4,
};

export interface PlayLevelRequest {
  learn: number[];
  scoreOn: number;
  settings?: PlayLevelSettings;
}

interface Tally {
  plays: number;
  yards: number;
  long: number;
}

const empty = (): Tally => ({ plays: 0, yards: 0, long: 0 });

const add = (into: Map<string, Tally>, key: string, yards: number) => {
  const own = into.get(key) ?? empty();
  own.plays++;
  own.yards += yards;
  if (yards >= 20) own.long++;
  into.set(key, own);
};

const per = (own: Tally | undefined, middle: number, steadyAt: number) => {
  if (!own || own.plays <= 0) {
    return middle;
  }

  const trust = own.plays / (own.plays + steadyAt);

  return trust * (own.yards / own.plays) + (1 - trust) * middle;
};

interface Play {
  season: number;
  week: number;
  offence: string;
  defence: string;
  down: number;
  toGo: number;
  yardline: number;
  margin: number;
  secondsLeft: number;
  call: Call;
  player: string;
  passer: string;
  yards: number;
}

/** what was known going into a season, from every one before it */
interface Known {
  byMan: Map<string, Tally>;
  byPasser: Map<string, Tally>;
  byOffence: Map<string, Tally>;
  byDefence: Map<string, Tally>;
  byCoordinator: Map<string, Tally>;
  teamOf: Map<string, string>;
  middleOn: (call: Call) => number;
  middlePass: number;
}

function knownBefore(
  plays: Play[], upTo: number, coaches: Map<string, string>,
): Known {
  const byMan = new Map<string, Tally>();
  const byPasser = new Map<string, Tally>();
  const byOffence = new Map<string, Tally>();
  const byDefence = new Map<string, Tally>();
  const byCoordinator = new Map<string, Tally>();
  const league = new Map<string, Tally>();
  const teamOf = new Map<string, string>();

  for (const play of plays) {
    if (play.season >= upTo) {
      continue;
    }

    add(league, play.call, play.yards);
    add(byOffence, `${play.offence}|${play.call}`, play.yards);
    add(byDefence, `${play.defence}|${play.call}`, play.yards);

    const called = coaches.get(`${play.offence}|${play.season}|OC`);

    if (called) {
      add(byCoordinator, `${called}|${play.call}`, play.yards);
    }

    if (play.player) {
      add(byMan, `${play.player}|${play.call}`, play.yards);
      teamOf.set(play.player, play.offence);
    }

    if (play.passer) {
      add(byPasser, play.passer, play.yards);
    }
  }

  const middleOn = (call: Call) => {
    const own = league.get(call);
    return own && own.plays > 0 ? own.yards / own.plays : 5;
  };
  const passing = league.get("pass");

  return {
    byMan, byPasser, byOffence, byDefence, byCoordinator, teamOf, middleOn,
    middlePass: passing && passing.plays > 0 ? passing.yards / passing.plays : 6.5,
  };
}

/** the row a tree is asked about, in a fixed order */
function rowFor(
  known: Known, onField: DefenceOnField, coaches: Map<string, string>,
  state: { down: number; toGo: number; yardline: number; margin: number; secondsLeft: number },
  call: Call, player: string, sides: PlaySides, season: number,
): number[] {
  const middle = known.middleOn(call);
  const his = known.byMan.get(`${player}|${call}`);
  const before = coaches.get(`${sides.offence}|${season - 1}|OC`) ?? "";
  const now = coaches.get(`${sides.offence}|${season}|OC`) ?? "";

  return [
    state.down, state.toGo, state.yardline, state.margin, state.secondsLeft,
    per(his, middle, 60) / middle,
    his && his.plays > 0 ? his.long / his.plays : 0.05,
    sides.passer
      ? per(known.byPasser.get(sides.passer), known.middlePass, 400) / known.middlePass
      : 1,
    per(known.byOffence.get(`${sides.offence}|${call}`), middle, 200) / middle,
    per(known.byDefence.get(`${sides.defence}|${call}`), middle, 200) / middle,
    his ? his.plays : 0,
    sides.season && sides.week && sides.defence
      ? onField.weekOf(sides.season, sides.week, sides.defence) ?? 0
      : 0,
    per(known.byCoordinator.get(`${now}|${call}`), middle, 400) / middle,
    per(known.byCoordinator.get(`${before}|${call}`), middle, 400) / middle,
  ];
}

const NAMES = [
  "down", "to go", "yards to the goal", "the score", "seconds left",
  "his own yards", "how often he breaks a long one", "his quarterback's yards",
  "this offence's yards", "this defence's yards", "his touches behind him",
  "the men on that defence this week", "his coordinator's own yards",
  "the coordinator before him",
];

export async function buildPlayLevel(
  request: PlayLevelRequest,
): Promise<PlayLevel> {
  const settings = request.settings ?? LEVEL_DEFAULTS;
  const coaches = await loadCoaches();
  const plays: Play[] = parseCsv(await readFile(
    join(import.meta.dirname, "..", "..", "data", "curated", "touches.csv"), "utf8",
  ))
    .map((r) => ({
      season: Number(r["season"]), week: Number(r["week"]),
      offence: r["offense"] ?? "", defence: r["defense"] ?? "",
      down: Number(r["down"]), toGo: Number(r["togo"]),
      yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
      secondsLeft: Number(r["seconds"]) || 1800,
      call: (r["playType"] ?? "") as Call,
      player: r["player"] ?? "", passer: r["passer"] ?? "",
      yards: Number(r["yards"]) || 0,
    }))
    .filter((p) => p.player && (p.call === "run" || p.call === "pass"));

  const onField = await buildDefenceOnField({
    learn: request.learn.slice(0, 2),
    describe: [...request.learn, request.scoreOn],
  });
  const forests = new Map<Call, Forest>();
  const stuffing = new Map<Call, Forest>();

  /**
   * Whether the call is a run, over both calls at once. The pools
   * answer this off the down, the distance and the spot; this can
   * also see the staff calling it and the men the defence has on the
   * field, which is where a run rate ought to move.
   */
  const callRows: number[][] = [];
  const wasRun: number[] = [];

  for (const season of request.learn) {
    const knownThen = knownBefore(plays, season, coaches);

    for (const play of plays) {
      if (play.season !== season || !play.call) {
        continue;
      }

      callRows.push(rowFor(
        knownThen, onField, coaches, play, play.call, "",
        {
          offence: play.offence, defence: play.defence, passer: play.passer,
          season: play.season, week: play.week,
        },
        season,
      ));
      wasRun.push(play.call === "run" ? 1 : 0);
    }
  }

  const callForest = callRows.length > 5000
    ? fitForest({
        rows: callRows, target: wasRun, names: NAMES,
        settings: {
          ...TREE_DEFAULTS, trees: settings.trees, depth: settings.depth,
        },
      })
    : undefined;
  /** a sample of what was learned on, for centring the ratios */
  const held = new Map<Call, { row: number[] }[]>();
  const middles = new Map<Call, number>();
  let learnedOn = 0;

  for (const call of ["run", "pass"] as Call[]) {
    const rows: number[][] = [];
    // what a gain came to once it was one, kept apart from whether
    // there was one at all
    const gained: number[] = [];
    const stuffed: number[] = [];

    for (const season of request.learn) {
      const known = knownBefore(plays, season, coaches);

      for (const play of plays) {
        if (play.season !== season || play.call !== call) {
          continue;
        }

        rows.push(rowFor(
          known, onField, coaches, play, call, play.player,
          {
            offence: play.offence, defence: play.defence, passer: play.passer,
            season: play.season, week: play.week,
          },
          season,
        ));
        gained.push(Math.max(0, play.yards));
        stuffed.push(play.yards <= 0 ? 1 : 0);
      }
    }

    const settingsFor = {
      ...TREE_DEFAULTS, trees: settings.trees, depth: settings.depth,
    };
    forests.set(call, fitForest({
      rows, target: gained, names: NAMES, settings: settingsFor,
    }));
    stuffing.set(call, fitForest({
      rows, target: stuffed, names: NAMES, settings: settingsFor,
    }));
    middles.set(call, gained.reduce((a, b) => a + b, 0) / Math.max(1, gained.length));
    held.set(call, rows.filter((_, i) => i % 7 === 0).map((row) => ({ row })));
    learnedOn += rows.length;
  }

  // what the model was told going into the season being walked
  const known = knownBefore(plays, request.scoreOn, coaches);
  /**
   * The people columns set to nobody in particular, so the same
   * situation can be asked about with an average cast. The situation
   * columns are left alone, since those are what gets divided out.
   */
  const neutral = new Map<number, number>([
    [5, 1], [6, 0.05], [7, 1], [8, 1], [9, 1], [10, 200], [11, 0],
    [12, 1], [13, 1],
  ]);

  /**
   * The same row with an average cast in it, so the situation can be
   * divided out. The draw this bends has already come from the pool
   * of plays at this spot, so a level that includes the situation
   * counts it twice.
   */
  const withNobody = (row: number[]) => {
    const nobody = [...row];

    for (const [at, value] of neutral) {
      nobody[at] = value;
    }

    return nobody;
  };
  const asked = (
    forest: Forest | undefined, state: PlayState, call: Call, player: string,
    sides: PlaySides,
  ) => {
    if (!forest || !player) {
      return undefined;
    }

    const row = rowFor(
      known, onField, coaches, state, call, player, sides, request.scoreOn,
    );
    const said = predictForest(forest, row);
    const plain = predictForest(forest, withNobody(row));

    return Number.isFinite(said) && Number.isFinite(plain)
      ? { said, plain }
      : undefined;
  };

  /**
   * What the ratio comes to on average, so it can be taken back out.
   *
   * A ratio of what the model says to what it says about nobody in
   * particular has no reason to average one, and if it averages 1.06
   * then every side gains six percent it never gained. The same
   * mistake cost three points a game when a receiver was compared
   * against a league average that included sacks.
   */
  const centres = new Map<Call, { stuffed: number; level: number }>();

  for (const call of ["run", "pass"] as Call[]) {
    const sample = held.get(call) ?? [];
    let stuffedTo = 0;
    let levelTo = 0;
    let seen = 0;

    for (const { row } of sample) {
      const stuffedForest = stuffing.get(call);
      const forest = forests.get(call);

      if (!stuffedForest || !forest) {
        continue;
      }

      const plainStuffed = predictForest(stuffedForest, withNobody(row));
      const plainLevel = predictForest(forest, withNobody(row));

      if (plainStuffed < 0.02 || plainLevel < 0.5) {
        continue;
      }

      stuffedTo += predictForest(stuffedForest, row) / plainStuffed;
      levelTo += predictForest(forest, row) / plainLevel;
      seen++;
    }

    centres.set(call, {
      stuffed: seen > 0 ? stuffedTo / seen : 1,
      level: seen > 0 ? levelTo / seen : 1,
    });
  }

  const centred = (value: number, by: number) =>
    Math.max(
      1 - settings.most, Math.min(1 + settings.most, value / Math.max(0.5, by)),
    );

  return {
    learnedOn,
    middleOn: (call) => middles.get(call) ?? 5,
    runsHere: (state, sides) => {
      if (!callForest) {
        return undefined;
      }

      const said = predictForest(callForest, rowFor(
        known, onField, coaches, state, "run", "", sides, request.scoreOn,
      ));

      return Number.isFinite(said)
        ? Math.max(0.05, Math.min(0.95, said))
        : undefined;
    },
    stuffedBy: (state, call, player, sides) => {
      const both = asked(stuffing.get(call), state, call, player, sides);

      if (!both || both.plain < 0.02) {
        return 1;
      }

      return centred(both.said / both.plain, centres.get(call)?.stuffed ?? 1);
    },
    levelFor: (state, call, player, sides) => {
      const forest = forests.get(call);
      const middle = middles.get(call) ?? 5;

      if (!forest || !player || middle <= 0.5) {
        return 1;
      }

      const row = rowFor(
        known, onField, coaches, state, call, player, sides, request.scoreOn,
      );
      const said = predictForest(forest, row);
      /**
       * And the same situation with nobody in particular in it.
       *
       * The draw this multiplies has already come from the pool of
       * plays at this down, distance and spot, so a level that
       * includes the situation counts it twice: the model was asked
       * what a play here is worth when the pool had already answered.
       * Dividing by an average cast leaves only the people.
       */
      const nobody = [...row];

      for (const [at, value] of neutral) {
        nobody[at] = value;
      }

      const plain = predictForest(forest, nobody);

      if (!Number.isFinite(said) || !Number.isFinite(plain) || Math.abs(plain) < 0.5) {
        return 1;
      }

      return centred(said / plain, centres.get(call)?.level ?? 1);
    },
  };
}

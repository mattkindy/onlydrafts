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
  /** what to multiply a drawn gain by, near one */
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

export const LEVEL_DEFAULTS: PlayLevelSettings = {
  most: 0.45, trees: 150, depth: 4,
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
  const middles = new Map<Call, number>();
  let learnedOn = 0;

  for (const call of ["run", "pass"] as Call[]) {
    const rows: number[][] = [];
    const target: number[] = [];

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
        target.push(play.yards);
      }
    }

    forests.set(call, fitForest({
      rows, target, names: NAMES,
      settings: { ...TREE_DEFAULTS, trees: settings.trees, depth: settings.depth },
    }));
    middles.set(call, target.reduce((a, b) => a + b, 0) / Math.max(1, target.length));
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

  return {
    learnedOn,
    middleOn: (call) => middles.get(call) ?? 5,
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

      return Math.max(
        1 - settings.most, Math.min(1 + settings.most, said / plain),
      );
    },
  };
}

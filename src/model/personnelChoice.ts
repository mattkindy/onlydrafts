/**
 * What an offence lines up in, as a function of the state rather than
 * a handful of named situations.
 *
 * Cutting the field into nine labels loses everything inside a label
 * and draws boundaries where there are none. Third and two at the five
 * is not third and two at the fifty, and a taxonomy that calls the
 * first one goal line and the second one third and short has thrown
 * the distinction away.
 *
 * So the state goes in as it is, and a weight per grouping comes out.
 * Fitted one against the rest, then normalised, which is cruder than a
 * proper multinomial fit but needs only the ridge already here.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";

export const GROUPINGS = ["11", "12", "21", "heavy", "spread"] as const;

export type Grouping = (typeof GROUPINGS)[number];

export interface PlayState {
  down: number;
  toGo: number;
  /** yards from the opponent's goal line */
  yardline: number;
  /** this team's lead, negative when behind */
  margin: number;
  /** seconds left in the game */
  seconds: number;
}

/**
 * How much of the call is the state and how much is the man making it.
 * Measured over 2022 to 2025, an offence's personnel mix repeats at
 * .19 to .23 under the same coordinator and at nothing at all under a
 * new one, so who is calling plays belongs in the model beside the
 * down and distance.
 */
export interface PersonnelHabit {
  /** this offence's own mix, as a share per grouping */
  mix: Record<Grouping, number>;
}

/**
 * The state as numbers a linear fit can use. Distance and field
 * position enter twice, once straight and once squared, because going
 * from one yard to five changes the call far more than fifteen to
 * twenty does.
 */
export function stateRow(state: PlayState, teams: string[] = [], team = ""): number[] {
  const toGo = Math.min(state.toGo, 25) / 10;
  const yard = state.yardline / 100;
  const late = state.seconds < 300 ? 1 : 0;

  return [
    1,
    state.down === 1 ? 1 : 0,
    state.down === 2 ? 1 : 0,
    state.down === 3 ? 1 : 0,
    state.down === 4 ? 1 : 0,
    toGo,
    toGo * toGo,
    yard,
    yard * yard,
    // inside the ten and inside the three, where the field runs out
    state.yardline <= 10 ? 1 : 0,
    state.yardline <= 3 ? 1 : 0,
    state.margin / 14,
    late,
    late * (state.margin < 0 ? 1 : 0),
    (state.down >= 3 ? 1 : 0) * toGo,
    // one column per offence, so the fit works out how much of the
    // call is the situation and how much is the man making it, rather
    // than being told afterward by a multiplier
    ...teams.map((name) => (name === team ? 1 : 0)),
  ];
}

export interface PersonnelModel {
  weights: Map<Grouping, number[]>;
  leagueMix: Record<Grouping, number>;
  /** the offences the fit knows about, in the order their columns sit */
  teams: string[];
}

export interface PersonnelExample extends PlayState {
  grouping: Grouping;
  offense?: string;
}

export function fitPersonnel(
  examples: PersonnelExample[],
  penalty = 20,
  withTeams = false,
): PersonnelModel {
  const teams = withTeams
    ? [...new Set(examples.map((e) => e.offense ?? ""))].filter(Boolean).sort()
    : [];
  const rows = examples.map((e) => stateRow(e, teams, e.offense ?? ""));
  const weights = new Map<Grouping, number[]>();

  for (const grouping of GROUPINGS) {
    weights.set(
      grouping,
      fitRidge(rows, examples.map((e) => (e.grouping === grouping ? 1 : 0)), penalty),
    );
  }

  const leagueMix = {} as Record<Grouping, number>;

  for (const grouping of GROUPINGS) {
    leagueMix[grouping] =
      examples.filter((e) => e.grouping === grouping).length / examples.length;
  }

  return { weights, leagueMix, teams };
}

/** an offence's own mix, for tilting the state's answer */
export function habitOf(examples: PersonnelExample[]): PersonnelHabit {
  const mix = {} as Record<Grouping, number>;

  for (const grouping of GROUPINGS) {
    mix[grouping] = examples.filter((e) => e.grouping === grouping).length /
      Math.max(1, examples.length);
  }

  return { mix };
}

/**
 * How likely each grouping is, from this state. Given a habit, the
 * state's answer is tilted toward what this offence usually does: it
 * says how the situation moves a team from its own baseline rather
 * than what a league-average team would line up in.
 */
export function personnelChances(
  model: PersonnelModel,
  state: PlayState,
  habit?: PersonnelHabit,
): Record<Grouping, number> {
  const row = stateRow(state, model.teams, (state as PersonnelExample).offense ?? "");
  const league = model.leagueMix;
  const raw = GROUPINGS.map((grouping) => {
    const fromState = Math.max(0.001, predictRidge(model.weights.get(grouping)!, row));

    if (!habit) {
      return fromState;
    }

    // the state's answer, scaled by how much this offence leans that way
    return fromState * (habit.mix[grouping] / Math.max(0.001, league[grouping]));
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  const out = {} as Record<Grouping, number>;

  GROUPINGS.forEach((grouping, i) => {
    out[grouping] = raw[i]! / total;
  });

  return out;
}

/** one grouping, drawn from those chances */
export function drawPersonnel(
  model: PersonnelModel,
  state: PlayState,
  uniform: () => number,
  habit?: PersonnelHabit,
): Grouping {
  const chances = personnelChances(model, state, habit);
  let left = uniform();

  for (const grouping of GROUPINGS) {
    left -= chances[grouping];

    if (left <= 0) {
      return grouping;
    }
  }

  return "11";
}

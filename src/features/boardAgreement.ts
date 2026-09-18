/**
 * Does the board agree with itself?
 *
 * A player's card shows a stat line and, beside it, the points a game
 * that line is meant to score. Those come from different fits, and
 * nothing used to check them against each other, so the board shipped
 * Devaughn Vele at 8.2 points a game beside a line worth 4.1 and Puka
 * Nacua at 21.5 beside one worth 35.9. This scores each line by the
 * board's own rules and reports everybody the two disagree about.
 *
 * `game.ev` says the same thing about the same game, so it is checked
 * too. `sim.ev` over `sim.games` is left alone: a mean season total
 * over a mean number of games is a different quantity.
 */

import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";

/** a row as the board file has it, with only the parts this reads */
export interface StatedPlayer {
  name?: string;
  key?: string;
  position?: string;
  ppg?: number;
  projected?: Record<string, number> | null;
  game?: Record<string, number> | null;
  sim?: (Record<string, number> & { games?: number }) | null;
}

export interface Disagreement {
  who: string;
  /** which pair of numbers disagrees */
  about: "the stat line" | "the spread";
  said: number;
  worth: number;
}

/**
 * Points and a stat line are both rounded for the file, which leaves a
 * few hundredths of slack, and a tenth on top of that is generous
 * without being enough to hide a player the two fits disagree about.
 */
export const AGREEMENT_SLACK = 0.15;

/**
 * And in fractions, for the players big enough that rounding is not the
 * question. A tenth of a point on a twenty point back is nothing.
 */
const AGREEMENT_SHARE = 0.02;

const apart = (said: number, worth: number) =>
  Math.abs(said - worth) >
    Math.max(AGREEMENT_SLACK, AGREEMENT_SHARE * Math.abs(worth));

/** what a league pays for one game of this line */
function scoreLine(
  parts: Record<string, number>, rules: ScoringRules,
): number {
  const line = {
    passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
    receptions: 0, recYds: 0, recTd: 0, fumblesLost: 0,
    twoPointConversions: 0,
  };

  for (const stat of Object.keys(line) as (keyof typeof line)[]) {
    line[stat] = parts[stat] ?? 0;
  }

  return fantasyPoints(line, rules);
}

/**
 * Every player whose stated points a game and his own stat line
 * disagree, under the rules the board was built with. A player with no
 * projected line, which is every kicker and every defence, has nothing
 * to check here.
 */
export function disagreements(
  players: StatedPlayer[], rules: ScoringRules,
): Disagreement[] {
  const found: Disagreement[] = [];

  for (const p of players) {
    if (!p.projected || p.ppg === undefined) {
      continue;
    }

    const who = p.name ?? p.key ?? "somebody";
    const worth = scoreLine(p.projected, rules);

    if (apart(p.ppg, worth)) {
      found.push({ who, about: "the stat line", said: p.ppg, worth });
    }

    const ev = p.game?.["ev"];

    if (ev !== undefined && apart(ev, p.ppg)) {
      found.push({ who, about: "the spread", said: ev, worth: p.ppg });
    }
  }

  return found;
}

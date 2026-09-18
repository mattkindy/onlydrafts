/**
 * The stat line behind a level, and how the two are kept in step.
 *
 * A player's level and his stat line come out of different fits, and
 * nothing used to make them agree: the board shipped a receiver at
 * eleven points of line beside one point a game. `partsAtLevel` is the
 * one place that reconciles them, and every writer of a projection
 * calls it and then reads the level back off the line it returns.
 *
 * The in-season update is the other half. Usage leads: targets,
 * carries and attempts come from what he has been given this season,
 * yards and catches and touchdowns follow their opportunity, and the
 * scored parts then move together to meet the level.
 */

import { fantasyPoints } from "../scoring/fantasyPoints.js";
import { scoring } from "../scoring/active.js";
import { PART_NAMES, type StatParts } from "./seasonSummary.js";
import type { UsagePerGame } from "./inSeasonLevel.js";

/** each chance a player gets, and what he does with it */
const FROM_OPPORTUNITY: Record<keyof StatParts, keyof StatParts | undefined> = {
  targets: undefined,
  carries: undefined,
  passAtt: undefined,
  receptions: "targets",
  recYds: "targets",
  recTd: "targets",
  rushYds: "carries",
  rushTd: "carries",
  passYds: "passAtt",
  passTd: "passAtt",
  passCmp: "passAtt",
  interceptions: "passAtt",
};

/** the parts a league pays for, which is what the level has to agree with */
const SCORED: (keyof StatParts)[] = [
  "passYds", "passTd", "interceptions", "rushYds", "rushTd",
  "receptions", "recYds", "recTd",
];

/** how far the scored parts can be moved to meet the level */
const MOST_RESCALE = 5;

/**
 * Chances a game a player needs before what he does with one is worked
 * out from it. A receiver is projected for a fiftieth of a pass, so one
 * trick play in a four game window multiplied his passing yards tenfold.
 */
const MIN_OPPORTUNITY = 0.5;

/** what the run's own league pays for one game of this line */
export function pointsOfLine(parts: StatParts): number {
  return fantasyPoints(
    { ...parts, fumblesLost: 0, twoPointConversions: 0 },
    scoring(),
  );
}

function blank(): StatParts {
  return PART_NAMES.reduce((out, part) => {
    out[part] = 0;

    return out;
  }, {} as StatParts);
}

/**
 * The line moved so that scoring it comes out at `ppg`.
 *
 * The scored parts move together, which leaves his rates where they
 * stand against each other, and the chances he gets rise to cover the
 * catches and completions the level buys him.
 *
 * Where the move would be wilder than MOST_RESCALE the line stops
 * there, so a caller has to read the level back off what comes out
 * rather than assume it landed on the level it asked for.
 */
export function partsAtLevel(parts: StatParts, ppg: number): StatParts {
  const now = pointsOfLine(parts);

  if (now <= 0 || ppg <= 0) {
    return { ...parts };
  }

  const scale = Math.min(MOST_RESCALE, ppg / now);
  const moved = { ...parts };

  for (const part of SCORED) {
    moved[part] *= scale;
  }

  // a catch needs a throw at him, and the level is what pays, so the
  // chances follow the catches rather than the catches being cut back
  // to chances nothing scaled with them
  moved.targets = Math.max(moved.targets, moved.receptions);
  moved.passAtt = Math.max(moved.passAtt, moved.passCmp);

  return moved;
}

export interface PartsUpdate {
  /** the preseason line, per game */
  anchor: StatParts;
  /** what he has been given per game this season, latest games counting most */
  observed: UsagePerGame;
  /** how much of the level came from this season, 0 to 1 */
  fromSeason: number;
  /** the updated level over the preseason one */
  levelRatio: number;
}

/** the preseason line brought into line with what the season has shown */
export function updateParts(update: PartsUpdate): StatParts {
  const { anchor, observed, fromSeason, levelRatio } = update;
  const seen: Partial<Record<keyof StatParts, number>> = {
    targets: observed.targets,
    carries: observed.carries,
    passAtt: observed.passAttempts,
  };
  const moved = blank();
  const opportunityRatio = new Map<keyof StatParts, number>();

  for (const part of PART_NAMES) {
    const now = seen[part];

    if (now === undefined) {
      continue;
    }

    moved[part] = (1 - fromSeason) * anchor[part] + fromSeason * now;
    opportunityRatio.set(
      part,
      anchor[part] >= MIN_OPPORTUNITY ? moved[part] / anchor[part] : 1,
    );
  }

  for (const part of PART_NAMES) {
    const from = FROM_OPPORTUNITY[part];

    if (!from) {
      continue;
    }

    moved[part] = anchor[part] * (opportunityRatio.get(from) ?? 1);
  }

  return partsAtLevel(moved, levelRatio * pointsOfLine(anchor));
}

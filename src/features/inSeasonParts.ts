/**
 * The stat line behind an in-season level, moved with it.
 *
 * The level update reads this season and lowers a player whose role
 * shrank, but his card still showed the preseason targets and yards, so
 * the page said eleven points a game off a hundred and seven targets.
 *
 * Usage leads. Targets, carries and attempts per game come from what he
 * has been given this season, blended with the preseason line by the
 * same weight the level gives the season. Yards, catches and touchdowns
 * follow their opportunity, and then the scored parts move together
 * until the line rises and falls by the same ratio as the level. A
 * player who lost his role shows fewer targets, not a worse rate.
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

function pointsOf(parts: StatParts): number {
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

  const was = pointsOf(anchor);
  const now = pointsOf(moved);
  const rescale =
    was > 0 && now > 0
      ? Math.min(MOST_RESCALE, (levelRatio * was) / now)
      : 1;

  for (const part of SCORED) {
    moved[part] *= rescale;
  }

  // a catch he was never thrown is not a catch
  moved.receptions = Math.min(moved.receptions, moved.targets);
  moved.passCmp = Math.min(moved.passCmp, moved.passAtt);

  return moved;
}

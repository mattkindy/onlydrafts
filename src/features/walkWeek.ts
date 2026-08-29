/**
 * One week of football played by the walk, summed per man.
 *
 * The weekly bench and the site's slate build both need the same
 * thing: every fixture of a week played enough times that the noise
 * settles, each man's box scores averaged, and the afternoon sized by
 * the market where a line exists. Keeping it here keeps the two from
 * drifting apart.
 */

import { playGame, linesFrom, type Side } from "../model/gameFromDrives.js";
import { sizeOf } from "./gameSize.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";
import { seededRng } from "../sim/rng.js";
import type { PlayedWorld } from "./playedWorld.js";

export interface WalkedWeek {
  points: Map<string, number>;
  touches: Map<string, number>;
  tds: Map<string, number>;
  /** how many fixtures had both sides in the world */
  played: number;
}

export function walkWeek(
  world: PlayedWorld,
  season: number,
  week: number,
  fixtures: Record<string, string | undefined>[],
  rules: ScoringRules,
  runs: number,
): WalkedWeek {
  const points = new Map<string, number>();
  const touches = new Map<string, number>();
  const tds = new Map<string, number>();
  let played = 0;

  for (const r of fixtures) {
    if (Number(r["season"]) !== season || Number(r["week"]) !== week ||
        r["game_type"] !== "REG") {
      continue;
    }

    const home = world.sideFor(r["home_team"]!) as Side | null;
    const away = world.sideFor(r["away_team"]!) as Side | null;

    if (!home || !away) {
      continue;
    }

    played++;
    const total = Number(r["total_line"]);
    const spread = Number(r["spread_line"]);
    const bendFor = new Map<string, number>();

    if (Number.isFinite(total) && Number.isFinite(spread)) {
      for (const id of home.among) {
        bendFor.set(id, sizeOf({ total, favouredBy: spread }));
      }

      for (const id of away.among) {
        bendFor.set(id, sizeOf({ total, favouredBy: -spread }));
      }
    }

    for (let run = 0; run < runs; run++) {
      const rng = seededRng(
        season * 1000 + week * 37 +
        (r["home_team"]!.charCodeAt(0) * 131 + r["away_team"]!.charCodeAt(1)) +
        run * 7919,
      );
      const game = playGame(home, away, {
        rules: { ...world.rules, kickSucceeds: world.kicking.kickSucceeds },
        fourth: world.fourth,
        clock: {
          isLast: world.kicking.isLast, lastLength: world.kicking.lastLength,
        },
        ticking: world.ticking, season, week,
      }, rng);

      for (const [id, line] of linesFrom(game, [home, away])) {
        points.set(
          id,
          (points.get(id) ?? 0) +
            (bendFor.get(id) ?? 1) * fantasyPoints(line, rules) / runs,
        );
        touches.set(
          id,
          (touches.get(id) ?? 0) +
            ((line.carries ?? 0) + (line.targets ?? 0)) / runs,
        );
        tds.set(
          id,
          (tds.get(id) ?? 0) + (line.rushTd + line.recTd) / runs,
        );
      }
    }
  }

  return { points, touches, tds, played };
}

/**
 * How much of the mixed weekly order is the walk's, by position. The
 * two run even at running back, where the walk ties the ridge on its
 * own; everywhere else the ridge still knows more about the week and
 * takes three quarters of the say.
 */
export const WEEKLY_WALK_SHARE: Record<string, number> = {
  QB: 0.25, RB: 0.5, WR: 0.25, TE: 0.25,
};

/**
 * How much wider a man's week runs than the games the walk deals him.
 * One world deals every week, with no role changes and no hurt
 * teammates, so the walk's bands run narrow: stretched this much
 * around the middle, an 80% band covers 79.3% of 2024's played weeks
 * and 81.3% of 2025's, measured in scripts/walkBandEval.ts.
 */
export const DEALT_WIDER = 1.3;

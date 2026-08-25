/**
 * A whole season played out, fixture by fixture, for everybody at once.
 *
 * The walk already plays a game: two sides, their fitted play
 * behaviour, drives that end where drives end. This runs the published
 * schedule through it enough times that each man's week settles down,
 * and adds up what he did.
 *
 * Nothing here decides anything about a player. How often he runs it comes from
 * plays where he had the ball and his yards from what those plays made,
 * so a week against a good front is fewer runs and less on each one
 * rather than his average scaled by a number.
 */

import { playGame, linesFrom, type Side } from "../model/gameFromDrives.js";
import type { PlayedWorld } from "./playedWorld.js";
import { kickingVenue } from "./kickingVenue.js";
import type { Climate } from "./climate.js";
import { HOME } from "./climate.js";
import {
  addParts, noParts, scaleParts,
  type SeasonLines, type WeekLine,
} from "./boardSource.js";
import type { StatParts } from "./seasonSummary.js";

export interface Fixture {
  week: number;
  homeTeam: string;
  awayTeam: string;
  hour: number;
  indoors: boolean;
  homeRest: number;
  awayRest: number;
}

export interface WalkSettings {
  /** how many times to play the whole season */
  runs: number;
  /** how many games each man is expected to be available for */
  gamesFor: (playerId: string) => number;
  climate?: Climate;
}

/**
 * A roof is worth about five points of passing and a night kickoff
 * costs the running game a little. The walk gets these as a nudge to
 * how often a side throws, so they arrive as plays rather than as a
 * multiplier on the far end.
 */
function leanFor(indoors: boolean, night: boolean): number {
  return (indoors ? 1.03 : 1) * (night ? 0.99 : 1);
}

interface Tally {
  parts: StatParts;
  games: number;
  byWeek: Map<number, { parts: StatParts; games: number; opp: string; home: boolean }>;
}

export function walkSeason(
  world: PlayedWorld,
  fixtures: Fixture[],
  settings: WalkSettings,
  rng: () => number,
): Map<string, SeasonLines> {
  const tally = new Map<string, Tally>();
  const mine = (playerId: string): Tally => {
    const already = tally.get(playerId) ?? {
      parts: noParts(), games: 0, byWeek: new Map(),
    };
    tally.set(playerId, already);

    return already;
  };

  for (let run = 0; run < settings.runs; run++) {
    for (const fixture of fixtures) {
      const home = world.sideFor(fixture.homeTeam);
      const away = world.sideFor(fixture.awayTeam);

      if (!home || !away) {
        continue;
      }

      const night = fixture.hour >= 18;
      const withLean = (side: Side, short: boolean): Side => ({
        ...side,
        lift: (side.lift ?? 1) * leanFor(fixture.indoors, night) *
          (short ? 1.01 : 1),
      });
      const playing = [
        withLean(home, fixture.homeRest <= 4),
        withLean(away, fixture.awayRest <= 4),
      ] as [Side, Side];

      // the ground this fixture is played on, which changes the kick
      // and whether they go for it instead
      const venue = venueOf(fixture, settings.climate, rng);
      const game = playGame(playing[0], playing[1], {
        rules: {
          ...world.rules,
          kickSucceeds: world.kicking.kickSucceeds,
          kickHere: (yardline: number) => kickingVenue.bend(yardline, venue),
          kickAppetite: kickingVenue.appetite(venue),
        },
        fourth: world.fourth,
        clock: {
          isLast: world.kicking.isLast,
          lastLength: world.kicking.lastLength,
        },
        ticking: world.ticking,
        week: fixture.week,
      }, rng);

      for (const [playerId, line] of linesFrom(game, playing)) {
        const his = mine(playerId);
        const asParts: Partial<StatParts> = {
          passYds: line.passYds, passTd: line.passTd,
          interceptions: line.interceptions,
          rushYds: line.rushYds, rushTd: line.rushTd,
          receptions: line.receptions, recYds: line.recYds, recTd: line.recTd,
          passAtt: line.passAtt ?? 0, passCmp: line.passCmp ?? 0,
          carries: line.carries ?? 0, targets: line.targets ?? 0,
        };

        addParts(his.parts, asParts);
        his.games++;

        const forTeam = home.among.includes(playerId)
          ? { opp: fixture.awayTeam, home: true }
          : { opp: fixture.homeTeam, home: false };
        const week = his.byWeek.get(fixture.week) ?? {
          parts: noParts(), games: 0, opp: forTeam.opp, home: forTeam.home,
        };
        addParts(week.parts, asParts);
        week.games++;
        his.byWeek.set(fixture.week, week);
      }
    }
  }

  const out = new Map<string, SeasonLines>();

  for (const [playerId, his] of tally) {
    if (his.games === 0) {
      continue;
    }

    const byWeek: WeekLine[] = [...his.byWeek.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([week, w]) => ({
        week,
        opponent: w.opp,
        home: w.home,
        parts: scaleParts(w.parts, 1 / Math.max(1, w.games)),
      }));

    out.set(playerId, {
      perGame: scaleParts(his.parts, 1 / his.games),
      byWeek,
      games: settings.gamesFor(playerId),
    });
  }

  return out;
}

/** the ground and the day, for a kicker who cares where he is standing */
export function venueOf(fixture: Fixture, climate: Climate | undefined, rng: () => number) {
  const where = HOME[fixture.homeTeam];

  if (fixture.indoors || where?.indoors) {
    return { indoors: true };
  }

  if (!climate) {
    return { indoors: false, temperature: 60, wind: 6 };
  }

  return {
    indoors: false,
    temperature: climate.drawTemperature(
      fixture.homeTeam, fixture.week, fixture.hour, rng,
    ),
    wind: climate.drawWind(fixture.homeTeam, rng),
  };
}

export { kickingVenue };

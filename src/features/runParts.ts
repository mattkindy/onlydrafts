/**
 * What a back should be expected to make on a carry.
 *
 * His own before-contact yards carry to the next season at .61 while
 * his coordinator stays and .37 once that coordinator leaves, so the
 * part of him the scheme set up is worth less when the scheme goes.
 * What he makes after contact follows him through a move at .35 and
 * is left alone.
 *
 * Handing him his side's before-contact instead of his own does not
 * work: it orders backs at -.02 where his own last season orders them
 * at .34. Pulling his own toward the league when his coordinator goes
 * keeps that ordering and takes 4% off the error.
 */

import { loadCoaches } from "../data/coaches.js";
import { loadRushingSeasons, pfrToGsis } from "../data/advancedStats.js";

/** the reference writes some sides differently from the play file */
const SAME_TEAM: Record<string, string> = {
  GNB: "GB", KAN: "KC", NOR: "NO", NWE: "NE", SFO: "SF", TAM: "TB",
  LVR: "LV", OAK: "LV", STL: "LA", SDG: "LAC", RAM: "LA", RAI: "LV",
  CRD: "ARI", RAV: "BAL", HTX: "HOU", CLT: "IND", OTI: "TEN",
};

export const asTeam = (team: string): string => SAME_TEAM[team] ?? team;

export interface RunParts {
  /**
   * What this back should make a carry for this side, or nothing when
   * the reference has not covered him.
   */
  levelFor: (offence: string, player: string) => number | undefined;
  /** what an average back makes, so a level can be read against it */
  leagueCarry: number;
  /** yards this offence opens before anybody gets a hand on the back */
  beforeFor: (offence: string) => number;
  /** and what this back makes once they do */
  afterFor: (player: string) => number;
  leagueBefore: number;
  leagueAfter: number;
  /** whether this side still has the coordinator who set up its runs */
  keptCoordinator: (offence: string) => boolean;
  /** how much of what made a back different survives that coordinator going */
  keepsWithoutHim: number;
  /** how many sides and men we could say anything about */
  knownSides: number;
  knownBacks: number;
}

export interface RunPartsRequest {
  /** the season being walked; what is known comes from the ones before */
  season: number;
  /** how many carries before a man's own number is taken at face value */
  steadyAt?: number;
  /**
   * How much of what made a back different survives his coordinator
   * leaving. Everything about him carries to the next season about
   * three fifths as well once that coordinator has gone.
   */
  keepsWithoutHim?: number;
}

interface Piece {
  yards: number;
  carries: number;
}

const add = (into: Map<string, Piece>, key: string, per: number, carries: number) => {
  const own = into.get(key) ?? { yards: 0, carries: 0 };
  own.yards += per * carries;
  own.carries += carries;
  into.set(key, own);
};

const rateOf = (piece: Piece | undefined, fallback: number) =>
  piece && piece.carries > 0 ? piece.yards / piece.carries : fallback;

/**
 * What each side and each back should be expected to do.
 *
 * A side keeps its own number only while its coordinator stays. When
 * he leaves there is nothing to carry forward: a back arriving under a
 * new coordinator is no better predicted by the men already there than
 * by the league, so the league is what he gets.
 */
export async function buildRunParts(
  request: RunPartsRequest,
): Promise<RunParts> {
  const steadyAt = request.steadyAt ?? 120;
  const keepsWithoutHim = request.keepsWithoutHim ?? 0.6;
  const coaches = await loadCoaches();
  const toGsis = await pfrToGsis();
  const seasons = await loadRushingSeasons(20);
  const before = new Map<string, Piece>();
  const hisBefore = new Map<string, Piece>();
  const after = new Map<string, Piece>();
  const league: Piece = { yards: 0, carries: 0 };
  const leagueAfter: Piece = { yards: 0, carries: 0 };

  for (const row of seasons) {
    if (row.season >= request.season) {
      continue;
    }

    // last season only for a side, since a scheme is asked about the
    // staff who are there now, and everything he has done for a back
    if (row.season === request.season - 1) {
      add(before, asTeam(row.team), row.beforeContact, row.attempts);
      league.yards += row.beforeContact * row.attempts;
      league.carries += row.attempts;
    }

    const id = toGsis.get(row.pfrId);

    if (id) {
      add(after, id, row.afterContact, row.attempts);
      add(hisBefore, id, row.beforeContact, row.attempts);
    }

    leagueAfter.yards += row.afterContact * row.attempts;
    leagueAfter.carries += row.attempts;
  }

  const middleBefore = rateOf(league, 2.5);
  const middleAfter = rateOf(leagueAfter, 1.8);
  const kept = (team: string) =>
    coaches.get(`${team}|${request.season}|OC`) !== undefined &&
    coaches.get(`${team}|${request.season}|OC`) ===
      coaches.get(`${team}|${request.season - 1}|OC`);
  const sides = new Map<string, number>();

  for (const [team, piece] of before) {
    if (kept(team)) {
      sides.set(team, rateOf(piece, middleBefore));
    }
  }

  const pulledToLeague = (own: Piece | undefined, middle: number) => {
    if (!own || own.carries <= 0) {
      return middle;
    }

    const trust = own.carries / (own.carries + steadyAt);

    return trust * (own.yards / own.carries) + (1 - trust) * middle;
  };

  return {
    leagueBefore: middleBefore,
    leagueAfter: middleAfter,
    leagueCarry: middleBefore + middleAfter,
    levelFor: (offence, player) => {
      const mine = hisBefore.get(player);

      if (!mine || mine.carries <= 0) {
        return undefined;
      }

      // his own before-contact, pulled toward the league when the
      // coordinator who set it up has gone
      const trust = kept(asTeam(offence)) ? 1 : keepsWithoutHim;
      const his = pulledToLeague(mine, middleBefore);

      return trust * his + (1 - trust) * middleBefore +
        pulledToLeague(after.get(player), middleAfter);
    },
    keptCoordinator: (offence) => kept(asTeam(offence)),
    keepsWithoutHim,
    knownSides: sides.size,
    knownBacks: [...after.values()].filter((p) => p.carries >= 20).length,
    beforeFor: (offence) => sides.get(asTeam(offence)) ?? middleBefore,
    // a man's own number on few carries says little, so it is pulled
    // toward the league until he has run enough
    afterFor: (player) => pulledToLeague(after.get(player), middleAfter),
  };
}

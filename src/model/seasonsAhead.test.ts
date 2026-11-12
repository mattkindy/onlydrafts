import { describe, expect, it } from "vitest";
import type { AheadRow } from "../features/aheadRows.js";
import {
  aheadField, aheadTerms, AHEAD_TERMS, ageCurved, capitalOf, carriedForward,
  fitAgeCurve, fitAhead, isRelevant, LEFT_OUT, predictAhead, SHIPPED_TERMS,
  taughtOn,
} from "./seasonsAhead.js";

const aRow = (over: Partial<AheadRow> = {}): AheadRow => ({
  playerId: "00-0000001",
  name: "A Player",
  season: 2022,
  week: 10,
  position: "WR",
  team: "ARI",
  age: 25,
  experience: 3,
  drafted: { season: 2019, round: 2, overall: 50 },
  clubGames: 9,
  games: 9,
  points: 90,
  snapShare: 0.8,
  share: 0.2,
  last: { games: 17, points: 170 },
  standing: "active",
  roomTopShare: 0.25,
  ahead: [undefined, undefined, undefined],
  ...over,
});

/** a fake little league where next season's rate is this season's plus a rookie's lift */
function aLeague(): AheadRow[] {
  const rows: AheadRow[] = [];
  let seed = 7;
  const draw = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };

  for (let i = 0; i < 400; i++) {
    const ppg = 2 + 14 * draw();
    const rookie = draw() < 0.25;
    const games = 1 + Math.floor(8 * draw());
    const next = ppg + (rookie ? 3 : 0) + (draw() - 0.5);
    const gone = draw() < 0.1;

    rows.push(aRow({
      playerId: `p${i}`,
      position: "WR",
      age: 22 + 10 * draw(),
      experience: rookie ? 0 : 4,
      games,
      points: ppg * games,
      ahead: [gone ? { games: 0, points: 0 } : { games: 14, points: next * 14 }, undefined, undefined],
    }));
  }

  return rows;
}

describe("aheadTerms", () => {
  it("reads every term, in order", () => {
    const terms = aheadTerms(aRow());

    expect(terms).toHaveLength(AHEAD_TERMS.length);
    expect(terms[AHEAD_TERMS.indexOf("points a game so far")]).toBe(10);
    expect(terms[AHEAD_TERMS.indexOf("share of his club's games played")]).toBe(1);
    // nine games at ten and half of seventeen at ten
    expect(terms[AHEAD_TERMS.indexOf("points a game, this season and last")]).toBeCloseTo(10);
  });

  it("reads draft capital only in a player's first three seasons", () => {
    const capital = AHEAD_TERMS.indexOf("draft capital, first three seasons");

    expect(aheadTerms(aRow({ experience: 1 }))[capital]).toBeCloseTo(capitalOf({ overall: 50 }));
    expect(aheadTerms(aRow({ experience: 3 }))[capital]).toBe(0);
    expect(aheadTerms(aRow({ experience: 0, drafted: null }))[capital]).toBe(0);
  });

  it("reads a player who has not played as nought rather than as nothing", () => {
    const terms = aheadTerms(aRow({ games: 0, points: 0, last: undefined, clubGames: 0 }));

    expect(terms.every(Number.isFinite)).toBe(true);
  });
});

describe("capitalOf", () => {
  it("is worth more the earlier the pick and nothing undrafted", () => {
    expect(capitalOf({ overall: 3 })).toBeGreaterThan(capitalOf({ overall: 40 }));
    expect(capitalOf({ overall: 400 })).toBe(0);
    expect(capitalOf(null)).toBe(0);
  });
});

describe("the shipped terms", () => {
  it("are every term but the ones that lost", () => {
    expect(SHIPPED_TERMS.length + LEFT_OUT.length).toBe(AHEAD_TERMS.length);
    expect(SHIPPED_TERMS).toContain("draft capital, first three seasons");
    expect(SHIPPED_TERMS).not.toContain("on a reserve list");
  });
});

describe("fitAhead", () => {
  const league = aLeague();
  const fit = fitAhead(league, 1, { lambda: 1 });

  it("learns that a rookie grows", () => {
    const rookie = predictAhead(fit, aRow({ experience: 0, age: 22 }))!;
    const veteran = predictAhead(fit, aRow({ experience: 4, age: 22 }))!;

    expect(rookie.ppg - veteran.ppg).toBeGreaterThan(2);
  });

  it("keeps games inside a season and a rate above nought", () => {
    const nothing = predictAhead(fit, aRow({ games: 0, points: 0, last: undefined }))!;

    expect(nothing.ppg).toBeGreaterThanOrEqual(0);
    expect(nothing.games).toBeGreaterThanOrEqual(0);
    expect(nothing.games).toBeLessThanOrEqual(17);
  });

  it("has nothing to say at a position it was never taught", () => {
    expect(predictAhead(fit, aRow({ position: "TE" }))).toBeUndefined();
  });

  it("is taught only on seasons that have finished", () => {
    expect(taughtOn(league, 2)).toHaveLength(0);
    expect(fitAhead(league, 2).byPosition.size).toBe(0);
  });
});

describe("the baselines", () => {
  it("carry this season forward as it is", () => {
    expect(carriedForward(aRow({ games: 6, clubGames: 9, points: 60 })))
      .toEqual({ ppg: 10, games: 17 * 6 / 9 });
  });

  it("age it by what players that age kept", () => {
    // everybody keeps half his rate and all his games a season on
    const rows = [23, 25, 27, 29, 31].flatMap((age) =>
      Array.from({ length: 5 }, () => aRow({
        age, ahead: [{ games: 17, points: 5 * 17 }, undefined, undefined],
      })));
    const curve = fitAgeCurve(rows, 1);
    const aged = ageCurved(curve, aRow({ age: 27 }));

    expect(aged.ppg).toBeCloseTo(5);
    expect(aged.games).toBeCloseTo(17);
  });
});

describe("isRelevant", () => {
  it("takes a scorer, last season's scorer and a young high pick", () => {
    expect(isRelevant(aRow())).toBe(true);
    expect(isRelevant(aRow({ games: 0, points: 0 }))).toBe(true);
    expect(isRelevant(aRow({
      games: 0, points: 0, last: undefined, experience: 0,
      drafted: { season: 2022, round: 1, overall: 3 },
    }))).toBe(true);
  });

  it("leaves out a practice squad man and a quiet veteran", () => {
    expect(isRelevant(aRow({ standing: "practice" }))).toBe(false);
    expect(isRelevant(aRow({ points: 18, last: { games: 17, points: 34 } }))).toBe(false);
  });
});

describe("aheadField", () => {
  it("writes three seasons as a multiple of the board's rate", () => {
    expect(aheadField([
      { ppg: 13.9, games: 13.04 }, { ppg: 13.8, games: 13.5 }, { ppg: 0, games: 0 },
    ], 11.1)).toEqual([
      { of: 1.252, games: 13 }, { of: 1.243, games: 13.5 }, { of: 0, games: 0 },
    ]);
  });

  it("writes nothing for a rate too small to divide by or a season with no answer", () => {
    expect(aheadField([{ ppg: 3, games: 4 }, { ppg: 3, games: 4 }, { ppg: 3, games: 4 }], 0.6))
      .toBeUndefined();
    expect(aheadField([{ ppg: 3, games: 4 }, undefined, { ppg: 3, games: 4 }], 8))
      .toBeUndefined();
  });
});

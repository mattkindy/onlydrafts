import { describe, expect, it } from "vitest";
import {
  BENCH_SNAP_CEILING, calibration, chanceThenValue, fitRoleChance,
  fitRoleChanceAsOf, inCommittee, inheritedOpportunities, jobValue,
  priorMultiplier, roleChance, roleChanceTermNames, roleChanceWeights,
  scoreContingent, shrunkEfficiency, rankContingent, valueThenChance,
  wouldAverage,
  type ContingentCut, type ContingentScore, type RoleExample,
} from "./contingentSleepers.js";

const aCut = (over: Partial<ContingentCut> = {}): ContingentCut => ({
  season: 2024,
  week: 6,
  playerId: "00-0000001",
  playerName: "A Backup",
  position: "RB",
  club: "NE",
  price: 180,
  drafted: false,
  priceMedian: 6,
  opportunities: 0,
  ownOpportunities: 0,
  opportunityPoints: 0,
  lastOpportunities: 0,
  lastOpportunityPoints: 0,
  positionPerOpportunity: 0.7,
  starterOpportunities: 18,
  depthRank: 2,
  playersAhead: 1,
  snapShare: 0.2,
  starterGamesMissed: 2,
  starterListedWeeks: 0,
  starterListedNow: false,
  starterOffRoster: false,
  positionOpenRate: 0.3,
  weeksLeft: 12,
  ...over,
});

/**
 * The middle of the draft at the age the prior neither adds to a player
 * nor takes from him, so the position mean comes through untouched and a
 * test can say what the shrink alone does.
 */
const plainPrior = (over: Partial<ContingentCut> = {}): ContingentCut =>
  aCut({ draftOverall: 128, age: 25, ...over });

describe("shrunkEfficiency", () => {
  it("reads a player with no work of his own off the position", () => {
    expect(shrunkEfficiency(plainPrior())).toBeCloseTo(0.7, 6);
  });

  it("moves toward his own rate as his opportunities pile up", () => {
    const few = plainPrior({ opportunities: 10, opportunityPoints: 20 });
    const many = plainPrior({ opportunities: 300, opportunityPoints: 600 });

    expect(shrunkEfficiency(few)).toBeGreaterThan(0.7);
    expect(shrunkEfficiency(many)).toBeGreaterThan(shrunkEfficiency(few));
  });

  it("leaves a backup near his position even after a season of work", () => {
    const busy = plainPrior({ opportunities: 100, opportunityPoints: 300 });

    expect(shrunkEfficiency(busy)).toBeLessThan(1.4);
  });

  it("counts last season for less than this one", () => {
    const now = plainPrior({ opportunities: 50, opportunityPoints: 100 });
    const then = plainPrior({
      lastOpportunities: 50, lastOpportunityPoints: 100,
    });

    expect(shrunkEfficiency(now)).toBeGreaterThan(shrunkEfficiency(then));
    expect(shrunkEfficiency(then)).toBeGreaterThan(0.7);
  });
});

describe("priorMultiplier", () => {
  it("gives a first rounder more than an undrafted player", () => {
    const early = priorMultiplier(aCut({ draftOverall: 5, age: 25 }));
    const none = priorMultiplier(aCut({ age: 25 }));

    expect(early).toBeGreaterThan(1);
    expect(none).toBeLessThan(1);
  });

  it("takes a little off an older player", () => {
    const young = priorMultiplier(aCut({ age: 23 }));
    const old = priorMultiplier(aCut({ age: 30 }));

    expect(young).toBeGreaterThan(old);
  });

  it("stays inside half and one and a half", () => {
    const wild = priorMultiplier(aCut({ draftOverall: 1, age: 18 }));

    expect(wild).toBeLessThanOrEqual(1.5);
    expect(priorMultiplier(aCut({ age: 45 }))).toBeGreaterThanOrEqual(0.5);
  });
});

describe("inheritedOpportunities", () => {
  it("gives a back the same whatever the man in front was getting", () => {
    const behindAWorkhorse = aCut({ starterOpportunities: 30 });
    const behindACommittee = aCut({ starterOpportunities: 12 });

    expect(inheritedOpportunities(behindAWorkhorse))
      .toBeCloseTo(inheritedOpportunities(behindACommittee), 6);
    expect(inheritedOpportunities(behindAWorkhorse)).toBeLessThan(25);
  });

  it("gives a receiver more when he is already getting targets", () => {
    const quiet = aCut({ position: "WR", ownOpportunities: 1 });
    const busy = aCut({ position: "WR", ownOpportunities: 6 });

    expect(inheritedOpportunities(busy))
      .toBeGreaterThan(inheritedOpportunities(quiet));
  });

  it("never goes below nothing", () => {
    const odd = aCut({ starterOpportunities: -50, ownOpportunities: -50 });

    expect(inheritedOpportunities(odd)).toBeGreaterThanOrEqual(0);
  });
});

describe("wouldAverage", () => {
  it("is his rate times what a next man up at his position inherits", () => {
    const cut = plainPrior({ starterOpportunities: 20 });

    expect(wouldAverage(cut))
      .toBeCloseTo(0.7 * inheritedOpportunities(cut), 6);
  });

  it("no longer hands a backup a workhorse's whole load", () => {
    const behindAWorkhorse = plainPrior({ starterOpportunities: 30 });

    expect(wouldAverage(behindAWorkhorse)).toBeLessThan(0.7 * 30);
  });
});

describe("inCommittee", () => {
  it("covers the band where a backup is already splitting the job", () => {
    expect(inCommittee(aCut({ snapShare: 0.35 }))).toBe(true);
    expect(inCommittee(aCut({ snapShare: 0.1 }))).toBe(false);
    expect(inCommittee(aCut({ snapShare: 0.7 }))).toBe(false);
  });
});

/**
 * Backups whose job opened whenever they were already playing a lot, and
 * who scored like a starter only when they were playing a lot more. The
 * two outcomes differ so a fit on one can be told from a fit on the other.
 */
const madeUpBackups = (): RoleExample[] => {
  const examples: RoleExample[] = [];

  for (let i = 0; i < 200; i++) {
    const snapShare = (i % 10) / 10;
    examples.push({
      cut: aCut({
        season: 2020 + (i % 4),
        playerId: `00-00000${i}`,
        snapShare,
        depthRank: snapShare > 0.4 ? 2 : 3,
      }),
      becameStarter: snapShare > 0.4,
      scoredLikeStarter: snapShare > 0.7,
    });
  }

  return examples;
};

describe("fitRoleChance", () => {
  it("wants more rows than it has terms", () => {
    expect(() => fitRoleChance(madeUpBackups().slice(0, 3))).toThrow();
  });

  it("gives a busier backup the higher chance", () => {
    const fit = fitRoleChance(madeUpBackups());

    expect(roleChance(fit, aCut({ snapShare: 0.8 })))
      .toBeGreaterThan(roleChance(fit, aCut({ snapShare: 0.05 })));
  });

  it("keeps every chance inside nought and one", () => {
    const fit = fitRoleChance(madeUpBackups());

    for (const share of [-1, 0, 0.5, 1, 5]) {
      const chance = roleChance(fit, aCut({ snapShare: share }));

      expect(chance).toBeGreaterThan(0);
      expect(chance).toBeLessThanOrEqual(1);
    }
  });

  it("weighs one term per name, in order", () => {
    const weighed = roleChanceWeights(fitRoleChance(madeUpBackups()));

    expect(weighed.map((one) => one.term)).toEqual([...roleChanceTermNames]);
  });

  it("says what each term averaged, so an empty one can be told apart", () => {
    const weighed = roleChanceWeights(fitRoleChance(madeUpBackups()));
    const listed = weighed
      .find((one) => one.term === "weeks he has been listed");

    expect(listed?.average).toBe(0);
    expect(weighed.find((one) => one.term === "snap share so far")?.average)
      .toBeGreaterThan(0);
  });

  it("counts the outcome it was asked for", () => {
    const snaps = fitRoleChance(madeUpBackups());
    const points = fitRoleChance(
      madeUpBackups(), { outcome: "a starter's points" },
    );

    expect(snaps.outcome).toBe("half the snaps");
    expect(points.outcome).toBe("a starter's points");
    expect(points.opened).toBeLessThan(snaps.opened);
  });

  it("gives the narrower outcome the lower chance at the same snap share", () => {
    const snaps = fitRoleChance(madeUpBackups());
    const points = fitRoleChance(
      madeUpBackups(), { outcome: "a starter's points" },
    );
    const cut = aCut({ snapShare: 0.5 });

    expect(roleChance(points, cut)).toBeLessThan(roleChance(snaps, cut));
  });
});

/** a scored player made by hand, since only three of its fields are read */
const aScore = (
  roleChance: number, wouldAverage: number, pricePpg = 5,
): ContingentScore => ({
  season: 2024,
  week: 6,
  playerId: "00-0000001",
  playerName: "A Backup",
  position: "RB",
  price: 180,
  drafted: false,
  roleChance,
  wouldAverage,
  pricePpg,
  score: roleChance * (wouldAverage - pricePpg),
});

describe("chanceThenValue", () => {
  it("keeps two players in chance order across a band edge", () => {
    expect(chanceThenValue(0.05, aScore(0.11, 6)))
      .toBeGreaterThan(chanceThenValue(0.05, aScore(0.09, 35)));
  });

  it("orders on the value inside one band", () => {
    expect(chanceThenValue(0.05, aScore(0.11, 20)))
      .toBeGreaterThan(chanceThenValue(0.05, aScore(0.14, 6)));
  });

  it("widens what one band holds as the band widens", () => {
    expect(chanceThenValue(0.05, aScore(0.11, 20)))
      .toBeLessThan(chanceThenValue(0.05, aScore(0.19, 6)));
    expect(chanceThenValue(0.1, aScore(0.11, 20)))
      .toBeGreaterThan(chanceThenValue(0.1, aScore(0.19, 6)));
  });
});

describe("valueThenChance", () => {
  it("leads on the value and settles ties on the chance", () => {
    expect(valueThenChance(1, aScore(0.02, 12)))
      .toBeGreaterThan(valueThenChance(1, aScore(0.9, 6)));
    expect(valueThenChance(1, aScore(0.9, 12.4)))
      .toBeGreaterThan(valueThenChance(1, aScore(0.02, 12)));
  });
});

describe("jobValue", () => {
  it("is what the job pays over what his price already pays", () => {
    expect(jobValue(aScore(0.5, 12, 5))).toBeCloseTo(7, 6);
  });
});

describe("fitRoleChanceAsOf", () => {
  it("drops the season it is about to score and everything after it", () => {
    const fit = fitRoleChanceAsOf(2022, madeUpBackups());

    expect(fit.trainedOn).toEqual([2020, 2021]);
  });

  it("drops the backups already playing when given a snap ceiling", () => {
    const all = fitRoleChanceAsOf(2024, madeUpBackups());
    const quiet = fitRoleChanceAsOf(
      2024, madeUpBackups(), { snapCeiling: BENCH_SNAP_CEILING },
    );

    expect(quiet.examples).toBeLessThan(all.examples);
    expect(quiet.opened).toBe(0);
  });
});

describe("scoreContingent", () => {
  it("is the chance times the gap over what his price pays", () => {
    const fit = fitRoleChance(madeUpBackups());
    const cut = aCut({ age: 25, snapShare: 0.2, priceMedian: 6 });
    const said = scoreContingent(fit, cut);

    expect(said.score)
      .toBeCloseTo(said.roleChance * (said.wouldAverage - 6), 6);
    expect(said.pricePpg).toBe(6);
  });

  it("goes negative when the job pays less than his price does", () => {
    const fit = fitRoleChance(madeUpBackups());
    const said = scoreContingent(
      fit, aCut({ age: 25, priceMedian: 20, starterOpportunities: 5 }),
    );

    expect(said.score).toBeLessThan(0);
  });
});

describe("rankContingent", () => {
  it("puts the biggest claim first", () => {
    const fit = fitRoleChance(madeUpBackups());
    const ranked = rankContingent(fit, [
      aCut({ playerId: "small", position: "WR", ownOpportunities: 1 }),
      aCut({ playerId: "big", position: "WR", ownOpportunities: 9 }),
    ]);

    expect(ranked[0]!.playerId).toBe("big");
  });
});

describe("calibration", () => {
  it("cuts the rows into deciles of the chance", () => {
    const marked = Array.from({ length: 100 }, (_, i) => ({
      chance: i / 100,
      happened: i >= 50,
    }));

    const bins = calibration(marked);

    expect(bins).toHaveLength(10);
    expect(bins.every((bin) => bin.players === 10)).toBe(true);
    expect(bins[0]!.realized).toBe(0);
    expect(bins[9]!.realized).toBe(1);
  });

  it("says nothing about a decile nothing landed in", () => {
    expect(calibration([])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  calibration, fitRoleChance, fitRoleChanceAsOf, inCommittee, priorMultiplier,
  roleChance, roleChanceTermNames, roleChanceWeights, scoreContingent,
  shrunkEfficiency, rankContingent, wouldAverage,
  type ContingentCut, type RoleExample,
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
  opportunityPoints: 0,
  lastOpportunities: 0,
  lastOpportunityPoints: 0,
  positionPerOpportunity: 0.7,
  starterOpportunities: 18,
  depthRank: 2,
  playersAhead: 1,
  snapShare: 0.2,
  starterGamesMissed: 2,
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
    expect(shrunkEfficiency(few)).toBeLessThan(1.5);
    expect(shrunkEfficiency(many)).toBeGreaterThan(1.75);
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

describe("wouldAverage", () => {
  it("is his rate times the job in front of him", () => {
    const cut = plainPrior({ starterOpportunities: 20 });

    expect(wouldAverage(cut)).toBeCloseTo(0.7 * 20, 6);
  });

  it("grows with the size of the job", () => {
    const small = plainPrior({ starterOpportunities: 6 });
    const big = plainPrior({ starterOpportunities: 24 });

    expect(wouldAverage(big)).toBeGreaterThan(wouldAverage(small));
  });
});

describe("inCommittee", () => {
  it("covers the band where a backup is already splitting the job", () => {
    expect(inCommittee(aCut({ snapShare: 0.35 }))).toBe(true);
    expect(inCommittee(aCut({ snapShare: 0.1 }))).toBe(false);
    expect(inCommittee(aCut({ snapShare: 0.7 }))).toBe(false);
  });
});

/** backups whose job opened whenever they were already playing a lot */
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
});

describe("fitRoleChanceAsOf", () => {
  it("drops the season it is about to score and everything after it", () => {
    const fit = fitRoleChanceAsOf(2022, madeUpBackups());

    expect(fit.trainedOn).toEqual([2020, 2021]);
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
      aCut({ playerId: "small", starterOpportunities: 4 }),
      aCut({ playerId: "big", starterOpportunities: 30 }),
    ]);

    expect(ranked[0]!.playerId).toBe("big");
  });
});

describe("calibration", () => {
  it("cuts the rows into deciles of the chance", () => {
    const marked = Array.from({ length: 100 }, (_, i) => ({
      chance: i / 100,
      becameStarter: i >= 50,
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

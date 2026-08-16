import { describe, expect, it } from "vitest";
import { seededRng } from "../sim/rng.js";
import { normalDraw } from "../sim/normal.js";
import {
  FIRMNESS, shareDraw, simulateTeamWeek, type Draws, type PlayerRole,
} from "./playerWeek.js";

function drawsFrom(seed: number): Draws {
  const rng = seededRng(seed);
  return { uniform: rng, normal: () => normalDraw(rng) };
}

const TEAM = { passAttempts: 34, rushAttempts: 26, impliedTotal: 22 };

function receiver(id: string, targetShare: number): PlayerRole {
  return {
    playerId: id, position: "WR", targetShare, carryShare: 0,
    catchRate: 0.64, yardsPerCatch: 12.5, yardsPerCarry: 0,
    touchdownShare: targetShare, availability: 1,
  };
}

function correlation(a: number[], b: number[]): number {
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;

  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }

  return num / Math.sqrt(da * db);
}

describe("shareDraw", () => {
  it("always divides the whole thing up", () => {
    const draws = drawsFrom(7);

    for (let i = 0; i < 50; i++) {
      const shares = shareDraw([0.3, 0.25, 0.2, 0.25], 12, draws);
      expect(shares.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
    }
  });

  it("leaves out anyone with no role", () => {
    expect(shareDraw([0.5, 0, 0.5], 12, drawsFrom(3))[1]).toBe(0);
  });

  it("stays nearer the stated shares as the depth chart firms up", () => {
    const spread = (firmness: number) => {
      const draws = drawsFrom(11);
      const first: number[] = [];

      for (let i = 0; i < 400; i++) {
        first.push(shareDraw([0.3, 0.3, 0.4], firmness, draws)[0]!);
      }

      const mean = first.reduce((s, x) => s + x, 0) / first.length;
      return Math.sqrt(first.reduce((s, x) => s + (x - mean) ** 2, 0) / first.length);
    };

    expect(spread(40)).toBeLessThan(spread(4));
  });
});

describe("simulateTeamWeek", () => {
  it("gives team-mates competing for the ball a negative correlation", () => {
    const roster = [receiver("a", 0.28), receiver("b", 0.24), receiver("c", 0.18)];
    const draws = drawsFrom(19);
    const a: number[] = [], b: number[] = [];

    for (let i = 0; i < 4000; i++) {
      const lines = simulateTeamWeek(TEAM, roster, draws);
      a.push(lines[0]!.receptions);
      b.push(lines[1]!.receptions);
    }

    // the recorded bug was same-team catchers simulating at +0.07
    expect(correlation(a, b)).toBeLessThan(0);
  });

  it("hands a target share to the others when one man sits out", () => {
    const roster = [receiver("a", 0.28), receiver("b", 0.24)];
    const withBoth = { ...roster[1]!, availability: 1 };
    const withoutHim = { ...roster[1]!, availability: 0 };

    const meanFor = (second: PlayerRole) => {
      const draws = drawsFrom(23);
      let total = 0;

      for (let i = 0; i < 2000; i++) {
        total += simulateTeamWeek(TEAM, [roster[0]!, second], draws)[0]!.receptions;
      }

      return total / 2000;
    };

    expect(meanFor(withoutHim)).toBeGreaterThan(meanFor(withBoth));
  });

  it("scores no touchdowns for a man who is not on the field", () => {
    const roster = [receiver("a", 0.3), { ...receiver("b", 0.3), availability: 0 }];
    const draws = drawsFrom(5);

    for (let i = 0; i < 300; i++) {
      const line = simulateTeamWeek(TEAM, roster, draws)[1]!;
      expect(line.played).toBe(false);
      expect(line.recTd + line.rushTd).toBe(0);
    }
  });

  it("makes touchdown weeks lumpy rather than smoothly spread", () => {
    const roster = [receiver("a", 0.26), receiver("b", 0.26), receiver("c", 0.2)];
    const draws = drawsFrom(31);
    const scores: number[] = [];

    for (let i = 0; i < 3000; i++) {
      scores.push(simulateTeamWeek(TEAM, roster, draws)[0]!.recTd);
    }

    // most weeks none, a decent share exactly one, and two does happen
    const share = (n: number) => scores.filter((s) => s === n).length / scores.length;
    expect(share(0)).toBeGreaterThan(0.5);
    expect(share(1)).toBeGreaterThan(0.1);
    expect(share(2)).toBeGreaterThan(0.005);
  });
});

describe("how firmly a depth chart holds", () => {
  it("lets a backfield wander further than a receiving room", () => {
    expect(FIRMNESS.carries).toBeLessThan(FIRMNESS.targets);
  });

  it("shows that as wider weekly swings for the backs", () => {
    const spread = (firmness: number) => {
      const draws = drawsFrom(13);
      const shares: number[] = [];

      for (let i = 0; i < 600; i++) {
        shares.push(shareDraw([0.45, 0.35, 0.2], firmness, draws)[0]!);
      }

      const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
      return Math.sqrt(shares.reduce((a, b) => a + (b - mean) ** 2, 0) / shares.length) / mean;
    };

    expect(spread(FIRMNESS.carries)).toBeGreaterThan(spread(FIRMNESS.targets));
  });
});

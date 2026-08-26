import { describe, expect, it } from "vitest";
import { scriptFrom, liftFor, type Effect } from "./gameScript.js";

const effects: Effect[] = [
  { defence: "SF", carries: 0.93, targets: 1.05 },
  { defence: "TB", carries: 1.09, targets: 0.96 },
  { defence: "GB", carries: 1.0, targets: 1.0 },
];

describe("what a fixture does to a side's volume", () => {
  const script = scriptFrom(effects);

  it("leaves a level opponent alone", () => {
    expect(script.carries("GB")).toBeCloseTo(1, 10);
    expect(script.targets("GB")).toBeCloseTo(1, 10);
  });

  it("says nothing about a side it has never seen", () => {
    expect(script.carries("XXX")).toBe(1);
    expect(script.targets("XXX")).toBe(1);
  });

  /**
   * The walk is one model's opinion about a defence and its fit
   * explains a fortieth of a side's carries, so taking it whole would
   * claim more than it knows.
   */
  it("keeps half of what the walk said and no more", () => {
    expect(script.carries("SF")).toBeCloseTo(1 + 0.5 * -0.07, 6);
    expect(script.carries("TB")).toBeCloseTo(1 + 0.5 * 0.09, 6);
  });

  it("never moves a week more than a tenth or so", () => {
    const wild = scriptFrom([{ defence: "ZZ", carries: 2.5, targets: 0.1 }]);

    expect(wild.carries("ZZ")).toBeLessThanOrEqual(1.12);
    expect(wild.targets("ZZ")).toBeGreaterThanOrEqual(0.88);
  });

  it("runs the two the opposite way for a hard fixture", () => {
    expect(script.carries("SF")).toBeLessThan(1);
    expect(script.targets("SF")).toBeGreaterThan(1);
  });
});

describe("what a fixture is worth to one man", () => {
  const script = scriptFrom(effects);

  it("gives a man who only runs it the carries effect", () => {
    expect(liftFor(script, "SF", 1)).toBeCloseTo(script.carries("SF"), 10);
  });

  it("gives a man who only catches it the targets one", () => {
    expect(liftFor(script, "SF", 0)).toBeCloseTo(script.targets("SF"), 10);
  });

  it("puts a man who does both between the two", () => {
    const both = liftFor(script, "SF", 0.5);

    expect(both).toBeGreaterThan(script.carries("SF"));
    expect(both).toBeLessThan(script.targets("SF"));
  });

  it("does not run off the end when a share is nonsense", () => {
    expect(liftFor(script, "SF", 5)).toBeCloseTo(script.carries("SF"), 10);
    expect(liftFor(script, "SF", -2)).toBeCloseTo(script.targets("SF"), 10);
  });
});

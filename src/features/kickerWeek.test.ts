import { describe, expect, it } from "vitest";
import {
  drawKickerWeeks,
  LEAGUE_PAID,
  payKicker,
  projectKickerWeek,
  STANDARD_KICKER_PAYS,
  type KickerWeekRead,
} from "./kickerWeek.js";

const ordinary: KickerWeekRead = {
  ownPaid: [],
  lastYearPaid: 8.1,
  ownParts: {},
  ownGames: 0,
  impliedFor: 22.3,
  venue: { indoors: false, temperature: 60, wind: 6 },
};

describe("projectKickerWeek", () => {
  it("puts an ordinary kicker in an ordinary week near the league's own", () => {
    expect(projectKickerWeek(ordinary).paid).toBeCloseTo(LEAGUE_PAID, 0);
  });

  it("pays a kicker less where the line expects his side to score more", () => {
    const busy = projectKickerWeek({ ...ordinary, impliedFor: 30 });
    const quiet = projectKickerWeek({ ...ordinary, impliedFor: 15 });

    expect(busy.paid).toBeLessThan(quiet.paid);
  });

  it("sends him out more often indoors than in the cold", () => {
    const roof = projectKickerWeek({ ...ordinary, venue: { indoors: true } });
    const cold = projectKickerWeek({
      ...ordinary, venue: { indoors: false, temperature: 25, wind: 6 },
    });

    expect(roof.parts["fgm_40_49"]!).toBeGreaterThan(cold.parts["fgm_40_49"]!);
  });

  it("hands back rates that pay what it says they pay", () => {
    const line = projectKickerWeek(ordinary);

    expect(payKicker(line.parts, STANDARD_KICKER_PAYS)).toBeCloseTo(line.paid, 6);
  });

  it("counts the same kicks the ways a league counts them", () => {
    const { parts } = projectKickerWeek(ordinary);
    const bands = ["0_19", "20_29", "30_39", "40_49", "50_59", "60p"];

    expect(parts["fgm"]).toBeCloseTo(
      bands.reduce((sum, band) => sum + parts[`fgm_${band}`]!, 0), 6);
    expect(parts["fgm_50p"]).toBeCloseTo(
      parts["fgm_50_59"]! + parts["fgm_60p"]!, 6);
  });

  it("leans on a kicker's own rates once he has enough weeks behind him", () => {
    const wild = projectKickerWeek({
      ...ordinary,
      ownGames: 16,
      ownParts: { fgm_50_59: 2, xpm: 1 },
    });

    expect(wild.parts["fgm_50_59"]!)
      .toBeGreaterThan(projectKickerWeek(ordinary).parts["fgm_50_59"]! * 2);
  });
});

describe("drawKickerWeeks", () => {
  it("draws a spread that straddles the line it was drawn off", () => {
    const line = projectKickerWeek(ordinary);
    const weeks = drawKickerWeeks(
      line.parts, STANDARD_KICKER_PAYS, 7, 4000);
    const mean = weeks.reduce((sum, n) => sum + n, 0) / weeks.length;

    expect(mean).toBeCloseTo(line.paid, 0);
    expect(weeks[0]!).toBeLessThan(line.paid);
    expect(weeks[weeks.length - 1]!).toBeGreaterThan(line.paid);
  });

  it("comes back sorted, so a quantile can be read off it", () => {
    const weeks = drawKickerWeeks(
      { fgm_30_39: 1, xpm: 2 }, STANDARD_KICKER_PAYS, 7, 500);

    expect([...weeks].sort((a, b) => a - b)).toEqual(weeks);
  });
});

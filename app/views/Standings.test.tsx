import { describe, expect, it } from "vitest";
import { render } from "preact";
import type { Roster } from "../lib/providers.ts";
import type { WeekRef } from "../lib/slate.ts";
import { ordinal, placesOf, recordSays, standingSays } from "./Standings.tsx";
import { WeekPicker } from "./WeekPicker.tsx";

const team = (
  owner: string, wins: number, losses: number, pointsFor: number,
): Roster => ({
  owner, picks: [], keys: [], record: { wins, losses, ties: 0, pointsFor },
});

describe("where a team sits", () => {
  const teams = [
    team("Bench Mob", 3, 5, 881),
    team("demo", 4, 4, 984),
    team("Taco Corp", 4, 4, 930),
    team("Waiver Wire Wizards", 7, 1, 909),
  ];

  it("orders by wins, then by points scored", () => {
    expect(placesOf(teams).map((row) => [row.place, row.owner])).toEqual([
      [1, "Waiver Wire Wizards"], [2, "demo"], [3, "Taco Corp"], [4, "Bench Mob"],
    ]);
  });

  it("says a team's record and place in a few characters", () => {
    expect(standingSays(teams, "demo")).toBe("4-4 · 2nd");
    expect(standingSays(teams, "nobody here")).toBe("");
  });

  it("says nothing for a league that keeps no records", () => {
    expect(standingSays([{ owner: "demo", picks: [], keys: [] }], "demo")).toBe("");
  });

  it("writes a tie as a third figure, and only when there is one", () => {
    expect(recordSays({ wins: 4, losses: 3, ties: 1 })).toBe("4-3-1");
    expect(recordSays({ wins: 4, losses: 4, ties: 0 })).toBe("4-4");
  });

  it("puts th on the teens", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd",
    ]);
  });
});

describe("the week stepper", () => {
  const weeks: WeekRef[] = [7, 8, 9].map((week) => ({
    season: 2026, week, file: `data/slate-2026-${week}.json`,
  }));

  const drawn = (picked: WeekRef, onWeek: (w: WeekRef) => void) => {
    const into = document.createElement("div");

    render(<WeekPicker weeks={weeks} picked={picked} onWeek={onWeek} />, into);

    return into;
  };

  it("steps a week either way, and stops at the ends", () => {
    const went: number[] = [];
    const at = drawn(weeks[1]!, (w) => went.push(w.week));
    const [back, on] = Array.from(at.querySelectorAll<HTMLButtonElement>("button.step"));

    back!.click();
    on!.click();

    expect(went).toEqual([7, 9]);
    expect(drawn(weeks[0]!, () => {}).querySelector<HTMLButtonElement>(
      'button[aria-label="the week before"]')!.disabled).toBe(true);
    expect(drawn(weeks[2]!, () => {}).querySelector<HTMLButtonElement>(
      'button[aria-label="the week after"]')!.disabled).toBe(true);
  });

  it("offers the way back to the coming week from an old one", () => {
    const went: number[] = [];
    const at = drawn(weeks[0]!, (w) => went.push(w.week));
    const now = at.querySelector<HTMLButtonElement>("button.now")!;

    now.click();

    expect(went).toEqual([9]);
    expect(drawn(weeks[2]!, () => {}).querySelector("button.now")).toBeNull();
  });
});

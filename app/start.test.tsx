/**
 * The week's start/sit board, drawn against a fixture week.
 *
 * The fixture is a small hand-written slate rather than a built one, so
 * these run before any week has been built and still say whether the
 * view sorts, filters and calls a comparison the way it should.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact";
import { beforeEach, describe, expect, it } from "vitest";

import { Start } from "./views/Start.tsx";
import { WeekRanks } from "./views/WeekRanks.tsx";
import {
  isSplit, readSlate, rosterKeys, verdict, weekRefs, type SlateRow,
} from "./lib/slate.ts";

const slate = readSlate(JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "slate-2026-3.json"), "utf8"),
));

const WEEKS = [{ season: 2026, week: 3, file: "data/slate-2026-3.json" }];
const MINE = rosterKeys([{ name: "Bijan Robinson" }, { name: "Trey McBride" }]);

const at = (name: string): SlateRow =>
  slate.rows.find((r) => r.name === name)!;

let where: HTMLElement;

const draw = (roster: Set<string> | null = null) => {
  render(<WeekRanks slate={slate} roster={roster} />, where);
};

const names = () =>
  Array.from(where.querySelectorAll("table.ranks tbody .who"))
    .map((el) => el.textContent!.trim());

const click = (selector: string) => {
  (where.querySelector(selector) as HTMLElement).click();
};

/** the row for one man, so a test can press compare on him */
const rowFor = (name: string) =>
  Array.from(where.querySelectorAll("table.ranks tbody tr"))
    .find((tr) => tr.querySelector(".who")!.textContent!.trim() === name) as
    HTMLElement;

beforeEach(() => {
  localStorage.clear();
  where = document.createElement("div");
  document.body.appendChild(where);
});

describe("who to start", () => {
  it("draws every man on the slate", () => {
    draw();

    expect(where.querySelectorAll("table.ranks tbody tr").length)
      .toBe(slate.rows.length);
    expect(where.textContent).toContain("Josh Allen");
  });

  it("puts the highest blend first and works down", () => {
    draw();

    const shown = slate.rows
      .filter((r) => names().includes(r.name))
      .sort((a, b) => b.blend - a.blend);

    expect(names()).toEqual(shown.map((r) => r.name));
    expect(names()[0]).toBe("Josh Allen");
  });

  it("keeps only one position when you ask for one", async () => {
    draw();

    const qb = Array.from(where.querySelectorAll("#posfilter button"))
      .find((b) => b.textContent === "qb") as HTMLButtonElement;

    qb.click();
    await Promise.resolve();

    expect(names()).toEqual(
      slate.rows.filter((r) => r.position === "QB")
        .sort((a, b) => b.blend - a.blend).map((r) => r.name),
    );
  });

  it("marks your own men and can hide everybody else", async () => {
    draw(MINE);

    const mine = where.querySelectorAll("table.ranks tbody tr.mine");

    expect(mine.length).toBe(2);

    click(".controls input[type=checkbox]");
    await Promise.resolve();

    expect(names().sort()).toEqual(["Bijan Robinson", "Trey McBride"]);
  });

  it("has no roster switch when no league is connected", () => {
    draw();

    expect(where.querySelector(".controls input[type=checkbox]")).toBe(null);
  });

  it("flags the rows where we and Sleeper disagree", () => {
    draw();

    expect(isSplit(at("Ja'Marr Chase"))).toBe(true);
    expect(isSplit(at("Bijan Robinson"))).toBe(false);
    // a man Sleeper has no number for is not a disagreement
    expect(isSplit(at("Chase Brown"))).toBe(false);

    const flagged = where.querySelectorAll("table.ranks tbody tr.split");

    expect(flagged.length).toBe(1);
    expect(flagged[0]!.getAttribute("title"))
      .toContain("Sleeper is right about 55% of the time");
  });

  it("says which men are questionable or short of a starter", () => {
    draw();

    expect(rowFor("Ja'Marr Chase").textContent).toContain("questionable");
    expect(rowFor("Chase Brown").textContent).toContain("starter out");
    expect(rowFor("Trey McBride").textContent).toContain("missed 1");
  });

  it("compares two men at the same position", async () => {
    draw();

    rowFor("Josh Allen").click();
    await Promise.resolve();
    rowFor("Caleb Williams").click();
    await Promise.resolve();

    expect(where.querySelector(".clock")!.textContent)
      .toContain("start Josh Allen");
    expect(where.querySelector(".clock")!.textContent).toContain("83%");
  });

  it("starts over when the second man plays another position", async () => {
    draw();

    rowFor("Josh Allen").click();
    await Promise.resolve();
    rowFor("Puka Nacua").click();
    await Promise.resolve();

    expect(where.querySelector(".clock")).toBe(null);
    expect(where.textContent).toContain("Now pick another WR");
  });

  it("says no week is built yet when none is", () => {
    render(
      <Start
        weeks={[]} picked={null} onWeek={() => {}} slate={null} roster={null}
        games={[]} rows={new Map()} men={[]} mine={null} slots={null}
      />,
      where,
    );

    expect(where.textContent).toContain("No week has been built yet");
  });
});

describe("which of two to start", () => {
  it("calls a gap under two points a coin flip", () => {
    const call = verdict(at("Josh Allen"), at("Jalen Hurts"));

    expect(call.start).toBe(null);
    expect(call.says).toContain("coin flip");
    expect(call.says).toContain("54%");
  });

  it("leans one way between two and five points", () => {
    const call = verdict(at("Josh Allen"), at("Bo Nix"));

    expect(call.start!.name).toBe("Josh Allen");
    expect(call.says).toContain("lean Josh Allen");
    expect(call.says).toContain("66%");
  });

  it("calls it outright at five points or more", () => {
    const call = verdict(at("Bo Nix"), at("Caleb Williams"));

    expect(call.start!.name).toBe("Bo Nix");
    expect(call.says).toContain("start Bo Nix");
    expect(call.says).toContain("83%");
  });

  it("reads the same week under either set of field names", () => {
    const asBuilt = at("Jalen Hurts");
    const asContracted = readSlate({
      season: 2026, week: 3, generated: "2026-09-24T11:02:00.000Z",
      rows: [{
        playerId: "jalenhurts", name: "Jalen Hurts", position: "QB",
        team: "PHI", opponent: "DAL", home: false,
        ours: 23.9, sleeper: 23.1, blend: 23.5, floor: 13.2, ceiling: 35.6,
        questionable: false, gamesMissedRecent: 0, absenceShare: 0.11,
      }],
    }).rows[0]!;

    expect(asContracted).toEqual(asBuilt);
    expect(asBuilt.home).toBe(false);
    expect(asBuilt.opponent).toBe("DAL");
    expect(at("Josh Allen").home).toBe(true);
  });

  it("reads a week whichever way the index lists it", () => {
    expect(weekRefs([{ season: 2026, week: 4, file: "data/slate-2026-4.json" }], 2026))
      .toEqual([{ season: 2026, week: 4, file: "data/slate-2026-4.json" }]);
    expect(weekRefs([2, 1], 2026)).toEqual([
      { season: 2026, week: 1, file: "data/slate-2026-1.json" },
      { season: 2026, week: 2, file: "data/slate-2026-2.json" },
    ]);
    expect(weekRefs(undefined, 2026)).toEqual([]);
  });
});

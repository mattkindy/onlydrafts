/**
 * The league tab opens on the coming week from Tuesday on, so its recap
 * falls back on the week before until a game in the week on screen is over.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GameState, WeekGames } from "../lib/matchups.ts";
import type { Matchup, Side } from "../lib/providers.ts";
import { readRecapWeek, weekBefore, type RecapReads } from "../lib/recapWeek.ts";
import { layoutReport } from "../lib/shareReport.ts";
import { readSlate, weekRowsOf, type Slate, type WeekRef } from "../lib/slate.ts";
import { normalizeName } from "../lib/store.ts";
import { recapOf } from "./lastWeekReport.ts";
import { Matchups } from "./Matchups.tsx";
import type { WeekPoll } from "./scoreboard.ts";

const slate: Slate = readSlate(JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "fixtures", "slate-2026-3.json"), "utf8"),
));

const rows = weekRowsOf(slate, [], null);

const WEEKS: WeekRef[] = [
  { season: 2026, week: 3, file: "data/slate-2026-3.json" },
  { season: 2026, week: 4, file: "data/slate-2026-4.json" },
];

/** a side starting the fixture's players from `from`, each on his line */
function side(owner: string, from: number, extra: number): Side {
  const starters = slate.rows.slice(from, from + 4).map((row, at) => ({
    key: normalizeName(row.name),
    name: row.name,
    team: row.team,
    slot: ["QB", "RB", "WR", "TE"][at]!,
    points: Math.round(row.blend) + (at === 0 ? extra : 0),
  }));

  return {
    owner,
    points: starters.reduce((sum, s) => sum + s.points, 0),
    starters,
    bench: [],
  };
}

const GAMES: Matchup[] = [
  { sides: [side("Alpha", 0, 9), side("Bravo", 4, 0)] },
  { sides: [side("Charlie", 8, 3), side("Delta", 12, 0)] },
];

/** every team in the fixture at one point in its game */
const statesAt = (state: GameState) => new Map(
  slate.rows.map((row) => [row.team, state]));

const OVER = statesAt({ where: "post", left: 0 });
const BEFORE = statesAt({ where: "pre", left: 1 });

const pollOf = (week: number, states: Map<string, GameState>): WeekPoll => ({
  season: 2026,
  week,
  tick: 1,
  states,
  situations: new Map(),
  read: new Date("2026-09-29T12:00:00Z"),
  trouble: "",
});

/** the provider and the scoreboard, as last week's reads see them */
function readsOf(fail = false): RecapReads & { asked: number[] } {
  const asked: number[] = [];

  return {
    asked,
    matchupsFor: (week) => {
      asked.push(week);

      return fail
        ? Promise.reject(new Error("no route to sleeper"))
        : Promise.resolve(GAMES);
    },
    readGames: (): Promise<WeekGames> => Promise.resolve({
      states: OVER, situations: new Map(), nextKickoff: null,
    }),
    loadSlate: () => Promise.resolve(slate),
    rowsOf: (got) => weekRowsOf(got, [], null),
  };
}

/** long enough for the reads, their then, and the render after */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await act(() => Promise.resolve());
  }
}

describe("the league tab's recap", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(() => { render(null, root); });
    vi.restoreAllMocks();
  });

  const draw = async (
    week: number, states: Map<string, GameState>, reads: RecapReads,
  ) => {
    const shown = WEEKS.find((ref) => ref.week === week)!;
    const before = weekBefore(WEEKS, shown);

    await act(() => {
      render(
        <Matchups
          games={GAMES}
          rows={rows}
          players={[]}
          mine=""
          slots={["QB", "RB", "WR", "TE"]}
          pays={{}}
          provider="sleeper"
          scoreboard={pollOf(week, states)}
          season={2026}
          week={week}
          league="Test League"
          rosters={[]}
          lastWeek={before ? () => readRecapWeek(before, reads) : undefined}
        />,
        root,
      );
    });
    await settle();
  };

  const heading = () => root.querySelector(".review h3")?.textContent ?? null;

  it("recaps the week before while no game this week is over", async () => {
    const reads = readsOf();

    await draw(4, BEFORE, reads);

    expect(heading()).toBe("week 3 recap");
    expect(reads.asked).toEqual([3]);
  });

  it("recaps the week on screen once its games are over", async () => {
    const reads = readsOf();

    await draw(4, OVER, reads);

    expect(heading()).toBe("week 4 recap");
    expect(reads.asked).toEqual([]);
  });

  it("shows no recap and no error when last week cannot be read", async () => {
    await draw(4, BEFORE, readsOf(true));

    expect(root.querySelector(".review")).toBeNull();
    expect(root.textContent).not.toMatch(/could not|no route/i);
  });

  it("shares last week's recap under last week's number", async () => {
    const got = await readRecapWeek(WEEKS[0]!, readsOf());
    const report = recapOf(got, "Test League", {
      league: "Test League",
      season: 2026,
      week: 4,
      players: [],
      catchShift: 0,
      slots: ["QB", "RB", "WR", "TE"],
      rostered: new Set(),
    });
    const layout = layoutReport(report);

    expect(layout.subtitle).toBe("week 3 recap");
    expect(layout.blocks.length).toBeGreaterThan(0);
  });
});

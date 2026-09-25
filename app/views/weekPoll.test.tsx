/**
 * The page reads the scoreboard and the league's points on one clock, so
 * a card's points and its game clock never come from different minutes.
 */

import { render } from "preact";
import { useEffect } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GameState, WeekGames } from "../lib/matchups.ts";
import { useScoreboard, useWeekPoll, type WeekPoll } from "./scoreboard.ts";

const NOW = Date.parse("2026-09-27T17:30:00Z");
const MINUTE = 60_000;

const weekOf = (state: GameState, nextKickoff: number | null): WeekGames => ({
  states: new Map([["BUF", state]]),
  situations: new Map(),
  nextKickoff,
});

const LIVE = weekOf({ where: "in", left: 0.5 }, null);
const BEFORE = weekOf({ where: "pre", left: 1 }, NOW + 10 * MINUTE);

/** a scoreboard that answers only when the test says so */
function scoreboardAnswering(answer: WeekGames) {
  const reads: number[] = [];
  const waiting: (() => void)[] = [];
  const readGames = () => {
    reads.push(Date.now());

    return new Promise<WeekGames>((settle) => {
      waiting.push(() => settle(answer));
    });
  };

  return { reads, readGames, answerAll: () => waiting.splice(0).forEach((go) => go()) };
}

/** long enough for a read's then, catch and finally to have run */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** the page, cut down to its two reads: the scoreboard and the points */
function Page({ readGames, onPoints }: {
  readGames: () => Promise<WeekGames>;
  onPoints: (at: number) => void;
}) {
  const { tick } = useWeekPoll(2026, 3, "sleeper", readGames);

  useEffect(() => { onPoints(Date.now()); }, [tick]);

  return null;
}

describe("the page's two reads", () => {
  let root: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    root = document.createElement("div");
  });

  afterEach(async () => {
    await act(() => { render(null, root); });
    vi.useRealTimers();
  });

  it("read the points each time the scoreboard is read, and on no timer of their own", async () => {
    const board = scoreboardAnswering(LIVE);
    const points: number[] = [];

    await act(() => {
      render(<Page readGames={board.readGames} onPoints={(at) => points.push(at)} />, root);
    });
    await act(async () => { board.answerAll(); await settle(); });

    expect(board.reads).toEqual([NOW]);
    expect(points).toEqual([NOW]);
    // the one timer waiting is the scoreboard's
    expect(vi.getTimerCount()).toBe(1);

    await act(() => { vi.advanceTimersByTime(MINUTE); });

    expect(board.reads).toEqual([NOW, NOW + MINUTE]);
    expect(points).toEqual(board.reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wait with the scoreboard for the first kickoff when nothing is on", async () => {
    const board = scoreboardAnswering(BEFORE);
    const points: number[] = [];

    await act(() => {
      render(<Page readGames={board.readGames} onPoints={(at) => points.push(at)} />, root);
    });
    await act(async () => { board.answerAll(); await settle(); });
    await act(() => { vi.advanceTimersByTime(MINUTE); });

    expect(board.reads).toEqual([NOW]);
    expect(points).toEqual([NOW]);

    await act(() => { vi.advanceTimersByTime(9 * MINUTE); });

    expect(board.reads).toEqual([NOW, NOW + 10 * MINUTE]);
    expect(points).toEqual(board.reads);
  });
});

describe("a tab under the page", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
  });

  afterEach(async () => {
    await act(() => { render(null, root); });
    vi.unstubAllGlobals();
  });

  function Tab({ shared, onStates }: {
    shared: WeekPoll | null;
    onStates: (states: Map<string, GameState> | null) => void;
  }) {
    const { states } = useScoreboard(2026, 3, shared);

    onStates(states);

    return null;
  }

  it("reads the page's poll and asks for no scoreboard of its own", async () => {
    const fetched = vi.fn(() => Promise.reject(new Error("no network here")));
    vi.stubGlobal("fetch", fetched);
    const shared: WeekPoll = {
      season: 2026, week: 3, tick: 4, states: LIVE.states,
      situations: LIVE.situations, read: new Date(NOW), trouble: "",
    };
    let seen: Map<string, GameState> | null = null;

    await act(() => {
      render(<Tab shared={shared} onStates={(states) => { seen = states; }} />, root);
    });

    expect(seen).toBe(LIVE.states);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("gets no reading from a poll for another week", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network here"))));
    const shared: WeekPoll = {
      season: 2026, week: 2, tick: 4, states: LIVE.states,
      situations: LIVE.situations, read: new Date(NOW), trouble: "",
    };
    let seen: Map<string, GameState> | null = LIVE.states;

    await act(() => {
      render(<Tab shared={shared} onStates={(states) => { seen = states; }} />, root);
    });

    expect(seen).toBeNull();
  });
});

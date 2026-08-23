import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { loadBoard, loadMeta } from "./lib/data.ts";
import { rescore } from "./lib/board.ts";

const DATA = join(import.meta.dirname, "..", "docs", "data");

it("the shipped files load and score end to end", async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    const name = String(url).split("/").pop()!.split("?")[0]!;
    return { ok: true, json: async () => JSON.parse(readFileSync(join(DATA, name), "utf8")) };
  });

  const meta = await loadMeta();
  const board = await loadBoard(meta.boardSeason);
  const men = rescore(board.players, {
    teams: 12,
    slots: ["QB","RB","RB","WR","WR","TE","FLEX"],
    pays: { pass_yd:0.04, pass_td:4, int:-2, rush_yd:0.1, rush_td:6, rec_yd:0.1, rec_td:6, fum_lost:-2 },
  });

  console.log("season", meta.boardSeason, "players", men.length);
  for (const p of men.slice(0, 3)) {
    console.log(p.name, p.ppg, "x", p.games, "=", p.vor, "| weeks", p.weeks?.length);
  }

  // every man carries what the views read off him
  for (const p of men) {
    expect(Number.isFinite(p.ppg!), p.name).toBe(true);
    expect(Number.isFinite(p.vor!), p.name).toBe(true);
    expect(p.games! > 0 && p.games! <= 17, `${p.name} games ${p.games}`).toBe(true);
  }

  const withWeeks = men.filter((p) => (p.weeks?.length ?? 0) > 0);
  expect(withWeeks.length).toBeGreaterThan(300);

  /**
   * A week is a multiple of his own average, so it sits near 1. Men
   * projected at a tenth of a point a game are the exception: their
   * weeks round to nothing and the ratio collapses. Nobody reads a
   * week chart for a man that far down, so the bound is only that the
   * number is usable.
   */
  for (const p of withWeeks) {
    for (const w of p.weeks!) {
      expect(Number.isFinite(w.of) && w.of >= 0 && w.of < 3,
        `${p.name} w${w.w} ${w.of}`).toBe(true);
    }
  }

  const worthReading = withWeeks.filter((p) => (p.ownPpg ?? 0) >= 1);
  expect(worthReading.length).toBeGreaterThan(300);

  for (const p of worthReading) {
    for (const w of p.weeks!) {
      expect(w.of > 0.2 && w.of < 3, `${p.name} w${w.w} ${w.of}`).toBe(true);
    }
  }

  expect(men.filter((p) => p.position === "K").length).toBeGreaterThan(20);
  expect(men.filter((p) => p.position === "DEF").length).toBeGreaterThan(20);
});

/**
 * The big number on a card is the middle of his spread, and his value
 * is worked out from what he scores. If those are not the same number
 * the card argues with itself, which is how one man read 19.8 a game
 * above another at 20.1 while being worth less.
 */
it("says the same points per game everywhere it says it", async () => {
  const { readFileSync } = await import("node:fs");
  const file = JSON.parse(
    readFileSync(join(DATA, "board-2026.json"), "utf8"),
  ) as { players: Parameters<typeof rescore>[0] };
  const men = rescore(file.players, {
    teams: 12,
    slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"],
    pays: { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4 },
  });

  for (const p of men) {
    if (!p.game) {
      continue;
    }

    expect(Math.abs(p.game["ev"]! - p.ppg!), `${p.name} ${p.game["ev"]} vs ${p.ppg}`)
      .toBeLessThanOrEqual(0.1);
  }
});

/**
 * Nothing the board ships may be scored as zero by accident.
 *
 * Every category in the file has to reach the scorer. Chris Boswell
 * came out at 2 points a game because the board writes his field goal
 * yardage as fgmYds, a league writes it as fgm_yds, and the check for
 * whether we pay for a category ran against the wrong spelling.
 */
it("scores every category the board ships", async () => {
  const { readFileSync } = await import("node:fs");
  const { scorable } = await import("./lib/scoring.ts");
  const file = JSON.parse(
    readFileSync(join(DATA, "board-2026.json"), "utf8"),
  ) as { players: { projected?: Record<string, number>; simulated?: Record<string, number> }[] };
  const unknown = new Set<string>();

  for (const p of file.players) {
    for (const parts of [p.projected, p.simulated]) {
      for (const category of Object.keys(parts ?? {})) {
        if (!scorable(category)) {
          unknown.add(category);
        }
      }
    }
  }

  expect([...unknown]).toEqual([]);
});

it("gives a kicker a sensible afternoon", async () => {
  const { readFileSync } = await import("node:fs");
  const { payFor } = await import("./lib/scoring.ts");
  const file = JSON.parse(
    readFileSync(join(DATA, "board-2026.json"), "utf8"),
  ) as { players: { name: string; position: string; simulated?: Record<string, number> }[] };
  const kickers = file.players.filter((p) => p.position === "K" && p.simulated);

  expect(kickers.length).toBeGreaterThan(20);

  for (const k of kickers) {
    const scored = payFor(k.simulated!, {});
    expect(scored, `${k.name} scored ${scored.toFixed(1)}`).toBeGreaterThan(4);
    expect(scored, `${k.name} scored ${scored.toFixed(1)}`).toBeLessThan(14);
  }
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  const players = rescore(board.players, {
    teams: 12,
    slots: ["QB","RB","RB","WR","WR","TE","FLEX"],
    pays: { pass_yd:0.04, pass_td:4, int:-2, rush_yd:0.1, rush_td:6, rec_yd:0.1, rec_td:6, fum_lost:-2 },
  });

  console.log("season", meta.boardSeason, "players", players.length);
  for (const p of players.slice(0, 3)) {
    console.log(p.name, p.ppg, "x", p.games, "=", p.vor, "| weeks", p.weeks?.length);
  }

  // every player carries what the views read off him
  for (const p of players) {
    expect(Number.isFinite(p.ppg!), p.name).toBe(true);
    expect(Number.isFinite(p.vor!), p.name).toBe(true);
    expect(p.games! > 0 && p.games! <= 17, `${p.name} games ${p.games}`).toBe(true);
  }

  const withWeeks = players.filter((p) => (p.weeks?.length ?? 0) > 0);
  expect(withWeeks.length).toBeGreaterThan(300);

  // A week is a multiple of his own average. A player at a point a game
  // or less breaks that either way, and nobody reads his week chart,
  // so the bound here is only that the number is usable.
  for (const p of withWeeks) {
    for (const w of p.weeks!) {
      expect(Number.isFinite(w.of) && w.of >= 0 && w.of < 6,
        `${p.name} w${w.w} ${w.of}`).toBe(true);
    }
  }

  /**
   * Below four points a game the early weeks come from last year's
   * touches, and a backup who barely played lands well under his
   * depth-chart season line, so the bound below him is looser.
   *
   * Even above it a third-string quarterback projected from his draft
   * slot alone scores a season's worth while the weekly model, which
   * reads the depth chart, gives him a twentieth of a week.
   */
  const worthReading = withWeeks.filter((p) => (p.ownPpg ?? 0) >= 4);
  expect(worthReading.length).toBeGreaterThan(200);

  // a week at exactly zero is a player his club ruled out, which the
  // build writes on purpose so the app does not start him
  for (const p of worthReading) {
    for (const w of p.weeks!) {
      expect(
        w.of === 0 || (w.of > 0.02 && w.of < 3), `${p.name} w${w.w} ${w.of}`,
      ).toBe(true);
    }
  }

  expect(players.filter((p) => p.position === "K").length).toBeGreaterThan(20);
  expect(players.filter((p) => p.position === "DEF").length).toBeGreaterThan(20);
});

/**
 * What dropping your best back costs, against the same figure worked out
 * by hand.
 *
 * Ten points of win chance reads small to anybody who takes it for a
 * season number, so the check is that it is the weekly number it claims
 * to be: shift the mean of a weekly margin by the points he takes with
 * him and the normal curve says how much of the week you lose.
 */
it("prices dropping a first back the way the margin says it should", async () => {
  const { roomFor } = await import("./lib/draftShare.ts");
  const { dropsFor } = await import("./lib/waivers.ts");
  const { baselineFor, notePassCatchers } = await import("./lib/winShare.ts");
  const slots = [
    "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF",
    "BN", "BN", "BN", "BN", "BN", "BN",
  ];
  const file = JSON.parse(
    readFileSync(join(DATA, "board-2026.json"), "utf8"),
  ) as { players: Parameters<typeof rescore>[0] };
  const players = rescore(file.players, {
    teams: 12,
    slots,
    pays: {
      rec: 0.5, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6,
      pass_yd: 0.04, pass_td: 4, int: -2, fum_lost: -2,
    },
  });

  notePassCatchers(players, null);

  const named = (name: string) => players.find((p) => p.name.includes(name))!;
  const mine = [
    "Jahmyr Gibbs", "Saquon Barkley", "Quinshon Judkins", "Rico Dowdle",
    "Nico Collins", "Chris Godwin", "Xavier Worthy", "Omar Cooper",
    "Harold Fannin", "Lamar Jackson", "Matthew Stafford", "Cam Little",
  ].map(named).filter(Boolean);
  const draws = 1000;
  const room = roomFor(players, slots, 12, draws, null);
  const gibbs = named("Jahmyr Gibbs");
  const his = dropsFor(mine, slots, room).find((d) => d.p.key === gibbs.key)!;

  expect(his.starts).toBeGreaterThan(0.8);
  expect(his.takes).toBeGreaterThan(8);
  expect(his.before).toBeGreaterThan(his.after);

  const held = baselineFor(mine, slots, draws, room.wire);
  const margin = held.total.map((x, i) => x - room.opponent[i]!);
  const mean = margin.reduce((s, x) => s + x, 0) / margin.length;
  const sd = Math.sqrt(
    margin.reduce((s, x) => s + (x - mean) ** 2, 0) / margin.length);
  const phi = (z: number) =>
    0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI)));
  const byHand = phi(mean / sd) - phi((mean - his.takes) / sd);

  expect(
    Math.abs(his.costs - byHand),
    `model ${(100 * his.costs).toFixed(1)} vs by hand ${(100 * byHand).toFixed(1)}`,
  ).toBeLessThan(0.04);
});

/**
 * A defence is in the week's slate like anyone else, and the start/sit
 * view has to find it by the key it keys a defence with, which is the
 * side's abbreviation in lower case.
 */
it("puts a defence in the slate the views can find", async () => {
  const { readSlate } = await import("./lib/slate.ts");
  const { lineOf } = await import("./lib/matchups.ts");
  const file = JSON.parse(
    readFileSync(join(DATA, "slate-2026-1.json"), "utf8"),
  );
  const slate = readSlate(file);
  const defences = slate.rows.filter((r) => r.position === "DEF");

  expect(defences.length).toBeGreaterThan(20);

  for (const d of defences) {
    expect(d.blend, `${d.name} blend ${d.blend}`).toBeGreaterThan(1);
    expect(d.blend, `${d.name} blend ${d.blend}`).toBeLessThan(16);
    expect(d.floor).toBeLessThan(d.blend);
    expect(d.ceiling).toBeGreaterThan(d.blend);
    expect(d.opponent, d.name).not.toBe("");
  }

  const rows = new Map(slate.rows.map((r) => [r.playerId, r]));
  const buffalo = lineOf("buf", rows);

  expect(buffalo?.position).toBe("DEF");
  expect(buffalo?.team).toBe("BUF");
  expect(buffalo?.blend).toBeGreaterThan(1);
});

/**
 * The big number on a card is the middle of his spread, and his value
 * is worked out from what he scores. If those are not the same number
 * the card argues with itself, which is how one player read 19.8 a game
 * above another at 20.1 while being worth less.
 */
it("says the same points per game everywhere it says it", async () => {
  const { readFileSync } = await import("node:fs");
  const file = JSON.parse(
    readFileSync(join(DATA, "board-2026.json"), "utf8"),
  ) as { players: Parameters<typeof rescore>[0] };
  const players = rescore(file.players, {
    teams: 12,
    slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"],
    pays: { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4 },
  });

  for (const p of players) {
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
  ) as { players: {
    projected?: Record<string, number>;
    walked?: Record<string, number>;
    simulated?: Record<string, number>;
  }[] };
  const unknown = new Set<string>();

  for (const p of file.players) {
    for (const parts of [p.projected, p.walked, p.simulated]) {
      for (const category of Object.keys(parts ?? {})) {
        if (!scorable(category)) {
          unknown.add(category);
        }
      }
    }
  }

  expect([...unknown]).toEqual([]);
});

/**
 * Under an ordinary league's kicking rules, which is how a kicker is
 * ever scored. Nothing pays for a made kick by default, because the
 * board ships the same kick counted three ways and a rate for two of
 * them would pay him twice.
 */
it("gives a kicker a sensible afternoon", async () => {
  const kicking = {
    fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5,
    xpm: 1, xpmiss: -1, fgmiss: -1,
  };
  const { readFileSync } = await import("node:fs");
  const { payFor } = await import("./lib/scoring.ts");
  const file = JSON.parse(
    readFileSync(join(DATA, "board-2026.json"), "utf8"),
  ) as { players: { name: string; position: string; simulated?: Record<string, number> }[] };
  const kickers = file.players.filter((p) => p.position === "K" && p.simulated);

  expect(kickers.length).toBeGreaterThan(20);

  for (const k of kickers) {
    const scored = payFor(k.simulated!, kicking);
    expect(scored, `${k.name} scored ${scored.toFixed(1)}`).toBeGreaterThan(4);
    expect(scored, `${k.name} scored ${scored.toFixed(1)}`).toBeLessThan(14);
  }
});

/**
 * A kicker is a player like any other on the board. He used to arrive
 * with a stat line and nothing else, so his card had no range, no
 * season, and a full seventeen games while everyone around him was cut
 * to what the availability model gave them.
 */
describe("a kicker gets what everyone else gets", () => {
  let kickers: Record<string, unknown>[];

  beforeEach(async () => {
    const { readFileSync } = await import("node:fs");
    const file = JSON.parse(
      readFileSync(join(DATA, "board-2026.json"), "utf8"),
    ) as { players: Record<string, unknown>[] };
    kickers = file.players.filter((p) => p["position"] === "K");
  });

  it("has a spread, a season and a week by week", () => {
    expect(kickers.length).toBeGreaterThan(20);

    for (const k of kickers) {
      const game = k["game"] as Record<string, number> | null;
      const sim = k["sim"] as Record<string, number> | null;
      const weeks = k["weeks"] as unknown[] | undefined;

      expect(game, String(k["name"])).toBeTruthy();
      expect(game!["high"]).toBeGreaterThan(game!["low"]!);
      expect(sim!["games"]).toBeGreaterThan(12);
      expect(sim!["games"]).toBeLessThanOrEqual(17);
      expect(weeks!.length).toBe(17);
    }
  });

  it("misses an extra point now and then", () => {
    for (const k of kickers) {
      const parts = k["simulated"] as Record<string, number>;
      expect(parts["xpmiss"], String(k["name"])).toBeGreaterThan(0);
    }
  });

  it("counts his kicks the other ways a league counts them", async () => {
    const { payFor } = await import("./lib/scoring.ts");

    for (const k of kickers) {
      const parts = k["simulated"] as Record<string, number>;
      // a league paying a flat rate per made kick has to reach the same
      // kicks as one paying by band
      const byBand = ["fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49",
        "fgm_50_59", "fgm_60p"].reduce((s, b) => s + (parts[b] ?? 0), 0);
      expect(parts["fgm"]).toBeCloseTo(byBand, 3);
      expect(parts["fgm_50p"])
        .toBeCloseTo((parts["fgm_50_59"] ?? 0) + (parts["fgm_60p"] ?? 0), 3);

      // and a league that prices only the flat categories scores him
      const flat = payFor(parts, { fgm: 3, fgmiss: -1, xpm: 1, xpmiss: -1 });
      expect(flat, String(k["name"])).toBeGreaterThan(4);
    }
  });
});

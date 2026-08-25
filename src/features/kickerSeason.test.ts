import { describe, expect, it } from "vitest";
import { kickerSeason, type Fixture } from "./kickerSeason.js";
import { fitClimate, HOME, type Reading } from "./climate.js";
import { BANDS, type KickerHistory } from "./kickerFromWalk.js";
import { seededRng } from "../sim/rng.js";

const anyKicker: KickerHistory = {
  attempts: 120,
  made: 100,
  byBand: BANDS.map(() => ({ attempts: 20, made: 17 })),
  extraPointRate: 0.95,
};

/** enough weather to fit a climate that knows north from south */
function readings(): Reading[] {
  const rng = seededRng(3);
  const out: Reading[] = [];

  for (const team of Object.keys(HOME)) {
    for (let season = 0; season < 8; season++) {
      for (let week = 1; week <= 18; week++) {
        out.push({
          team, week, hour: 13,
          temperature: 70 - 2.2 * (HOME[team]!.latitude - 38) -
            2.1 * (week - 1) + (rng() - 0.5) * 14,
          wind: 6 + (rng() - 0.5) * 8,
        });
      }
    }
  }

  return out;
}

const climate = fitClimate(readings());
const yards = Array.from({ length: 400 }, (_, i) => 25 + (i % 30));

// weeks are compared against each other, and at a few hundred seasons
// the sampling moves them as much as the weather does
const SEASONS = 6000;

const playedAt = (fixtures: Fixture[]) =>
  kickerSeason(
    anyKicker, yards, 600, 300, 16, SEASONS, seededRng(7), fixtures, climate,
  );

const seventeen = (host: string, startWeek = 1) =>
  Array.from({ length: 17 }, (_, i) => ({
    week: startWeek + i, host, hour: 13,
  }));

describe("a kicker's season, week by week", () => {
  it("gives every week a share of what he averages", () => {
    const season = playedAt(seventeen("GB"));

    expect(season.byWeek).toHaveLength(17);
    const middle = season.byWeek.reduce((s, w) => s + w.of, 0) /
      season.byWeek.length;
    expect(middle).toBeGreaterThan(0.95);
    expect(middle).toBeLessThan(1.05);
  });

  it("makes a December week at a cold ground worse than a September one", () => {
    const { byWeek } = playedAt(seventeen("GB"));
    const early = byWeek.find((w) => w.w === 2)!;
    const late = byWeek.find((w) => w.w === 17)!;

    expect(late.of).toBeLessThan(early.of);
  });

  /**
   * The appetite term is most of this: a staff goes for it instead of
   * kicking when it is freezing, so he never gets on the field.
   */
  it("costs a cold ground more across a season than a warm one", () => {
    const north = playedAt(seventeen("GB"));
    const south = playedAt(seventeen("MIA"));

    expect(north.sim.ev).toBeLessThan(south.sim.ev);
  });

  it("moves a roof far less across a season than an open cold ground", () => {
    const spreadOf = (host: string) => {
      const { byWeek } = playedAt(seventeen(host));

      return Math.max(...byWeek.map((w) => w.of)) /
        Math.min(...byWeek.map((w) => w.of));
    };

    // how far each is above a flat season, since the sampling puts a
    // few points on both and only the difference means anything
    expect(spreadOf("DET") - 1).toBeLessThan((spreadOf("GB") - 1) * 0.5);
  });

  it("still plays a season for a kicker with no fixtures", () => {
    const season = kickerSeason(
      anyKicker, yards, 600, 300, 16, 200, seededRng(7),
    );

    expect(season.byWeek).toHaveLength(0);
    expect(season.sim.ev).toBeGreaterThan(0);
    expect(season.game.ev).toBeGreaterThan(0);
  });

  it("plays about the games he is expected to play", () => {
    const season = kickerSeason(
      anyKicker, yards, 600, 300, 12, 400, seededRng(7),
      seventeen("MIA"), climate,
    );

    const perSeason = season.sim.ev / season.game.ev;
    expect(perSeason).toBeGreaterThan(11);
    expect(perSeason).toBeLessThan(13);
  });
});

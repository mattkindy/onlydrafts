import { describe, expect, it } from "vitest";
import { render } from "preact";
import type { SlateRow } from "../lib/slate.ts";
import { WeatherMark, weatherWords } from "./WeatherMark.tsx";

const row = (extra: Partial<SlateRow>): SlateRow => ({
  playerId: "one",
  name: "A Player",
  position: "WR",
  team: "BUF",
  opponent: "NYJ",
  home: true,
  ours: 12,
  sleeper: null,
  blend: 12,
  floor: 4,
  ceiling: 22,
  catches: 4,
  questionable: false,
  ruledOut: false,
  gamesMissedRecent: 0,
  absenceShare: 0,
  ...extra,
});

function drawn(r: SlateRow): HTMLElement {
  const into = document.createElement("div");
  render(<WeatherMark row={r} />, into);

  return into;
}

describe("the forecast beside a name", () => {
  it("draws nothing at all for a row with no weather on it", () => {
    expect(drawn(row({})).querySelector(".badge.weather")).toBeNull();
  });

  it("draws a badge for a row the forecast moves", () => {
    const badge = drawn(row({
      weather: { wind: 18, temp: 28, wet: true, snow: false },
    })).querySelector(".badge.weather");

    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toBe("18 mph wind, 28 F, rain");
  });

  it("leaves the wind out of the title on a still cold day", () => {
    const badge = drawn(row({
      weather: { wind: 6, temp: 21, wet: false, snow: true },
    })).querySelector(".badge.weather");

    expect(badge?.getAttribute("title")).toBe("21 F, snow");
  });

  it("shows one glyph per thing the sky is doing", () => {
    const one = drawn(row({
      weather: { wind: 6, temp: 55, wet: true, snow: false },
    })).querySelector(".badge.weather");
    const lots = drawn(row({
      weather: { wind: 22, temp: 20, wet: false, snow: true },
    })).querySelector(".badge.weather");

    expect(one?.textContent?.length).toBe(1);
    expect(lots?.textContent?.length).toBe(3);
  });
});

describe("what the weather did to his line, in words", () => {
  it("says the conditions and how far the line moved", () => {
    expect(weatherWords(row({
      weather: { wind: 18, temp: 28, wet: true, snow: false },
      weatherLift: 0.91,
    }))).toBe("wind and cold and rain, line down 9%");
  });

  it("says nothing where the weather barely moved him", () => {
    expect(weatherWords(row({
      weather: { wind: 16, temp: 55, wet: false, snow: false },
      weatherLift: 0.998,
    }))).toBeUndefined();
  });

  it("says nothing where the build wrote no lift", () => {
    expect(weatherWords(row({
      weather: { wind: 18, temp: 28, wet: true, snow: false },
    }))).toBeUndefined();
  });
});

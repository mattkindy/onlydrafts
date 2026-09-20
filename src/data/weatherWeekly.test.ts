import { describe, expect, it } from "vitest";
import {
  HEADER, parseWeatherWeekly, rowOf, weatherNote,
} from "./weatherWeekly.js";

const file = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

describe("the week's forecasts", () => {
  it("reads a fixture back off its own row", () => {
    const [out] = parseWeatherWeekly(
      file("2026,3,BUF,18.4,31.2,2.60,80,forecast"),
    );

    expect(out).toEqual({
      season: 2026, week: 3, homeTeam: "BUF",
      wind: 18.4, temperature: 31.2,
      precipitation: 2.6, precipChance: 80,
      soaked: true, snow: true, source: "forecast",
    });
  });

  it("calls rain below freezing snow, which is what it falls as", () => {
    const [cold] = parseWeatherWeekly(file("2026,3,GB,8,25.0,2.00,90,forecast"));
    const [mild] = parseWeatherWeekly(file("2026,3,GB,8,50.0,2.00,90,forecast"));

    expect(cold?.snow).toBe(true);
    expect(mild?.snow).toBe(false);
    expect(mild?.soaked).toBe(true);
  });

  it("calls a drizzle dry, since a millimetre is where the fit was cut", () => {
    const [dry] = parseWeatherWeekly(file("2026,3,GB,6.0,55.0,0.40,60,forecast"));
    const [wet] = parseWeatherWeekly(file("2026,3,GB,6.0,55.0,1.00,60,forecast"));

    expect(dry?.soaked).toBe(false);
    expect(wet?.soaked).toBe(true);
  });

  it("keeps a fixture the forecast could not reach, marked as such", () => {
    const [out] = parseWeatherWeekly(
      file("2026,17,CHI,9.7,38.0,0.00,0,climate"),
    );

    expect(out?.source).toBe("climate");
    expect(out?.soaked).toBe(false);
  });

  it("drops a row with no wind or temperature on it", () => {
    expect(parseWeatherWeekly(file("2026,3,BUF,,,0.00,0,forecast"))).toEqual([]);
    expect(parseWeatherWeekly(file("2026,3,BUF,NA,40,0.00,0,forecast")))
      .toEqual([]);
  });

  it("comes back from an empty file with nothing rather than a broken row", () => {
    expect(parseWeatherWeekly("")).toEqual([]);
    expect(parseWeatherWeekly(file())).toEqual([]);
  });

  describe("whether a day is worth telling anyone about", () => {
    const only = (row: string) => weatherNote(parseWeatherWeekly(file(row))[0]);

    it("says nothing about a mild still dry afternoon", () => {
      expect(only("2026,3,TB,7,72.0,0.00,5,forecast")).toBeUndefined();
    });

    it("speaks up once the wind reaches fifteen", () => {
      expect(only("2026,3,BUF,14.4,70.0,0.00,0,forecast")).toBeUndefined();
      expect(only("2026,3,BUF,15.2,70.0,0.00,0,forecast"))
        .toEqual({ wind: 15, temp: 70, wet: false, snow: false });
    });

    it("speaks up under forty degrees", () => {
      expect(only("2026,3,GB,5,39.4,0.00,0,forecast"))
        .toEqual({ wind: 5, temp: 39, wet: false, snow: false });
      expect(only("2026,3,GB,5,41.0,0.00,0,forecast")).toBeUndefined();
    });

    it("tells wet from snow by how cold it is", () => {
      expect(only("2026,3,NE,6,48.0,2.00,80,forecast"))
        .toEqual({ wind: 6, temp: 48, wet: true, snow: false });
      expect(only("2026,3,GB,6,24.0,2.00,80,forecast"))
        .toEqual({ wind: 6, temp: 24, wet: false, snow: true });
    });

    it("has nothing to say about a fixture with no row", () => {
      expect(weatherNote(undefined)).toBeUndefined();
    });
  });

  it("writes a row the reader takes straight back", () => {
    const written = {
      season: 2026, week: 9, homeTeam: "NE",
      wind: 21.55, temperature: 33.49,
      precipitation: 1.234, precipChance: 45,
      soaked: true, snow: false, source: "forecast" as const,
    };
    const [back] = parseWeatherWeekly(file(rowOf(written)));

    expect(back?.homeTeam).toBe("NE");
    expect(back?.wind).toBeCloseTo(21.6, 5);
    expect(back?.temperature).toBeCloseTo(33.5, 5);
    expect(back?.soaked).toBe(true);
  });
});

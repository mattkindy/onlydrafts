import { describe, expect, it } from "vitest";
import { HEADER, parseWeatherWeekly, rowOf } from "./weatherWeekly.js";

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
      soaked: true, source: "forecast",
    });
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

  it("writes a row the reader takes straight back", () => {
    const written = {
      season: 2026, week: 9, homeTeam: "NE",
      wind: 21.55, temperature: 33.49,
      precipitation: 1.234, precipChance: 45,
      soaked: true, source: "forecast" as const,
    };
    const [back] = parseWeatherWeekly(file(rowOf(written)));

    expect(back?.homeTeam).toBe("NE");
    expect(back?.wind).toBeCloseTo(21.6, 5);
    expect(back?.temperature).toBeCloseTo(33.5, 5);
    expect(back?.soaked).toBe(true);
  });
});

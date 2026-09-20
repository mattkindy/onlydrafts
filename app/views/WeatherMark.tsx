/**
 * One glyph per thing the sky is doing, next to a name, reading like
 * the injury badges beside it.
 *
 * The slate only writes a forecast onto a row where it would move him,
 * so a row that has one always has something to say and the badge never
 * renders empty. The numbers go in the title rather than on the badge,
 * since Matt reads this on a phone.
 */

import type { SlateRow, WeatherNote } from "../lib/slate.ts";

/** wind, cold, rain, snow, in the order a title reads them */
const GLYPHS: { holds: (w: WeatherNote) => boolean; mark: string }[] = [
  { holds: (w) => w.wind >= 15, mark: "≈" },
  { holds: (w) => w.temp < 40, mark: "❄" },
  { holds: (w) => w.wet, mark: "☂" },
  { holds: (w) => w.snow, mark: "☃" },
];

/** the same four in words, for the tooltip */
function words(w: WeatherNote): string {
  const said: string[] = [];

  if (w.wind >= 15) {
    said.push(`${w.wind} mph wind`);
  }

  said.push(`${w.temp} F`);

  if (w.wet) {
    said.push("rain");
  }

  if (w.snow) {
    said.push("snow");
  }

  return said.join(", ");
}

/** how much of his line the weather took, where it took enough to say */
export function weatherWords(row: SlateRow): string | undefined {
  const lift = row.weatherLift;

  if (!row.weather || lift === undefined || Math.abs(1 - lift) < 0.01) {
    return undefined;
  }

  const w = row.weather;
  const parts: string[] = [];

  if (w.wind >= 15) {
    parts.push("wind");
  }

  if (w.temp < 40) {
    parts.push("cold");
  }

  if (w.snow) {
    parts.push("snow");
  } else if (w.wet) {
    parts.push("rain");
  }

  const how = Math.round(Math.abs(1 - lift) * 100);

  return `${parts.join(" and ")}, line ${lift < 1 ? "down" : "up"} ${how}%`;
}

export function WeatherMark({ row }: { row: SlateRow }) {
  const w = row.weather;

  if (!w) {
    return null;
  }

  const marks = GLYPHS.filter((g) => g.holds(w)).map((g) => g.mark).join("");

  return (
    <span class="badge weather" title={words(w)} data-testid="weather">
      {marks}
    </span>
  );
}

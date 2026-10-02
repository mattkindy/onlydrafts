/**
 * The week dropdown. The matchup and league tabs share one picked week,
 * so either tab can move it.
 */

import type { WeekRef } from "../lib/slate.ts";

export function WeekPicker(
  { weeks, picked, onWeek }: {
    weeks: WeekRef[];
    picked: WeekRef | null;
    onWeek: (week: WeekRef) => void;
  },
) {
  return (
    <label>
      week{" "}
      <select
        value={picked ? String(picked.week) : ""}
        onChange={(e) => {
          const want = Number(e.currentTarget.value);
          const found = weeks.find((w) => w.week === want);

          if (found) {
            onWeek(found);
          }
        }}
      >
        {weeks.map((w) => (
          <option key={w.file} value={String(w.week)}>
            week {w.week}
          </option>
        ))}
      </select>
    </label>
  );
}

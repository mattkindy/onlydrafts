/**
 * The week stepper. The matchup and league tabs share one picked week,
 * so either tab can move it.
 *
 * It used to be a dropdown alone in a bordered panel, a full row of a
 * phone for one number, and going back a week meant opening a list and
 * aiming at the line above. The arrows do the common move in one tap;
 * the week in the middle is still a dropdown for jumping further.
 */

import type { WeekRef } from "../lib/slate.ts";

export function WeekPicker(
  { weeks, picked, onWeek }: {
    weeks: WeekRef[];
    picked: WeekRef | null;
    onWeek: (week: WeekRef) => void;
  },
) {
  const at = picked ? weeks.findIndex((w) => w.week === picked.week) : -1;
  const before = at > 0 ? weeks[at - 1] : undefined;
  const after = at >= 0 && at < weeks.length - 1 ? weeks[at + 1] : undefined;
  // the newest week built is the one coming up, which is the one people mean
  const latest = at >= 0 && at === weeks.length - 1;

  return (
    <span class="weekstep">
      <button
        class="step"
        aria-label="the week before"
        disabled={!before}
        onClick={() => before && onWeek(before)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <label>
        <span class="vh">week</span>
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
      <button
        class="step"
        aria-label="the week after"
        disabled={!after}
        onClick={() => after && onWeek(after)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      {!latest && after && (
        <button
          class="quiet now"
          onClick={() => onWeek(weeks[weeks.length - 1]!)}
        >
          this week
        </button>
      )}
    </span>
  );
}

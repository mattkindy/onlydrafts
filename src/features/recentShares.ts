/**
 * What share of his side's work a man has been taking lately.
 *
 * The walk's allocation takes its level from the August projection and
 * lets the state-conditioned counts only lean it. Those counts pool
 * every season in the play file at the same weight, so a man who was a
 * starter in 2022 and a backup since still shows up at his 2022 size.
 * This reads each season on its own, as his share of what his side
 * ran, and averages them with the latest worth much more than the ones
 * before it. A season with few weeks in it counts for less, and a
 * season a man sat out counts at nought once he has arrived, which
 * stops an old level from standing.
 */

/** a run share and a throw share, the two halves the walk asks for */
export interface RecentShare {
  carries: number;
  targets: number;
}

/** one touch, as the curated play file has it */
export interface TouchRow {
  season: number;
  week: number;
  offence: string;
  call: string;
  player: string;
}

/**
 * How much a season counts against the one after it. Hard, because
 * the failure this is answering is a stale level rather than a noisy
 * one: at 0.35 a man two seasons back is worth an eighth of last
 * season and three back almost nothing.
 */
const LEVEL_FADE = Number(process.env["LEVEL_FADE"] ?? 0.35);
/**
 * How many weeks a season needs before it speaks at full strength.
 * The same four the in-season blend already trusts at, so three weeks
 * of a new season is worth about as much as the season before it and
 * ten weeks is worth three times as much.
 */
const SETTLES_AT = Number(process.env["LEVEL_SETTLES"] ?? 4);

interface PerSeason {
  carries: number;
  targets: number;
  team: string;
}

/**
 * Each man's recency-weighted share of the carries and of the targets.
 *
 * Rows from the season being played are expected to be already cut to
 * the weeks that had happened; nothing here filters them.
 */
export function recentShares(
  rows: TouchRow[], through: number,
): Map<string, RecentShare> {
  const byMan = new Map<string, PerSeason>();
  const bySide = new Map<string, { carries: number; targets: number }>();
  const sideWeeks = new Map<string, Set<number>>();
  const arrived = new Map<string, number>();

  for (const row of rows) {
    if (row.call !== "run" && row.call !== "pass") {
      continue;
    }

    const side = `${row.offence}|${row.season}`;
    const ran = bySide.get(side) ?? { carries: 0, targets: 0 };

    if (row.call === "run") {
      ran.carries++;
    } else {
      ran.targets++;
    }

    bySide.set(side, ran);
    const weeks = sideWeeks.get(side) ?? new Set<number>();
    weeks.add(row.week);
    sideWeeks.set(side, weeks);

    if (!row.player) {
      continue;
    }

    const key = `${row.player}|${row.season}`;
    const own = byMan.get(key) ?? { carries: 0, targets: 0, team: row.offence };

    if (row.call === "run") {
      own.carries++;
    } else {
      own.targets++;
    }

    own.team = row.offence;
    byMan.set(key, own);
    arrived.set(
      row.player, Math.min(arrived.get(row.player) ?? row.season, row.season),
    );
  }

  const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
  const counts = new Map<number, number>();

  for (const season of seasons) {
    let weeks = 0;

    for (const [side, seen] of sideWeeks) {
      if (side.endsWith(`|${season}`)) {
        weeks = Math.max(weeks, seen.size);
      }
    }

    counts.set(
      season,
      Math.pow(LEVEL_FADE, through - season) * (weeks / (weeks + SETTLES_AT)),
    );
  }

  const out = new Map<string, RecentShare>();

  for (const [player, first] of arrived) {
    let carries = 0;
    let targets = 0;
    let weight = 0;

    for (const season of seasons) {
      if (season < first) {
        continue;
      }

      const counting = counts.get(season) ?? 0;
      weight += counting;
      const own = byMan.get(`${player}|${season}`);

      if (!own) {
        continue;
      }

      const ran = bySide.get(`${own.team}|${season}`);

      if (!ran) {
        continue;
      }

      // Missed games are left where they fall. Reading a man on the
      // weeks he played, the way the projection reads him, costs a
      // point of the share the walk gives the man who really got it.
      carries += counting * (own.carries / Math.max(1, ran.carries));
      targets += counting * (own.targets / Math.max(1, ran.targets));
    }

    if (weight > 0) {
      out.set(player, { carries: carries / weight, targets: targets / weight });
    }
  }

  return out;
}

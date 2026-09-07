/**
 * How much a Sunday inactive list would be worth, if we could get one.
 *
 * Our injury data is the Friday practice report. The official inactive
 * list goes out ninety minutes before kickoff and no free source has it
 * in time, so this measures the prize instead of claiming it: take the
 * weeks a man's touches came in at more than twice or less than half
 * his recent average, and ask how many the Friday report already knew
 * and how many the inactive list would have caught. The roster file's
 * INA status is that list arriving a day late, which is why it can be
 * used here and not in the weekly refresh.
 *
 * Run: npx tsx scripts/inactiveGapCheck.ts [--season 2025]
 */

import {
  loadPlayerStats,
  loadWeeklyRosters,
  type PlayerWeekStats,
} from "../src/data/nflverse.js";
import { loadWeeklyInjuryStatus } from "../src/data/weeklyStatus.js";
import { RECENT_GAMES } from "../src/features/recentWindow.js";

/** the ball goes to these three in a way that counts as a job */
const POSITIONS = ["RB", "WR", "TE"];

/** below this many touches a week there is no job to lose */
const HAS_A_JOB = 5;

const INACTIVE = "INA";

/** the weekly file has no row for a man who did nothing, so start late */
const FIRST_WEEK = 5;
const LAST_WEEK = 18;

function key(playerId: string, week: number): string {
  return `${playerId}|${week}`;
}

function touches(row: PlayerWeekStats): number {
  return row.targets + row.carries;
}

type Direction = "fell" | "rose";

function directionOf(recent: number, actual: number): Direction | undefined {
  if (actual < recent / 2) {
    return "fell";
  }

  if (actual > recent * 2) {
    return "rose";
  }

  return undefined;
}

interface Counts {
  weeks: number;
  fridayKnew: number;
  inactiveCatches: number;
  neither: number;
}

function emptyCounts(): Counts {
  return { weeks: 0, fridayKnew: 0, inactiveCatches: 0, neither: 0 };
}

function share(part: number, whole: number): string {
  return whole === 0 ? "  -" : `${((part / whole) * 100).toFixed(1)}%`;
}

function report(label: string, counts: Counts): void {
  console.log(
    `${label.padEnd(24)} ${String(counts.weeks).padStart(5)} weeks, ` +
      `friday knew ${share(counts.fridayKnew, counts.weeks).padStart(6)}, ` +
      `the inactive list adds ${share(counts.inactiveCatches, counts.weeks).padStart(6)}, ` +
      `neither ${share(counts.neither, counts.weeks).padStart(6)}`,
  );
}

interface Standing {
  playerId: string;
  teamId: string;
  position: string;
  week: number;
  /** what he averaged over the last four games he actually played */
  recent: number;
  actual: number;
}

/**
 * Every rostered man's week, whether or not the stats file has a row
 * for him. The roster file is the universe here because a man who did
 * not play has no stats row at all, and those are the weeks in
 * question.
 */
function standings(
  rosters: Awaited<ReturnType<typeof loadWeeklyRosters>>,
  stats: PlayerWeekStats[],
): Standing[] {
  const byPlayer = new Map<string, PlayerWeekStats[]>();

  for (const row of stats) {
    const list = byPlayer.get(row.playerId) ?? [];
    list.push(row);
    byPlayer.set(row.playerId, list);
  }

  for (const list of byPlayer.values()) {
    list.sort((a, b) => a.week - b.week);
  }

  const rowAt = new Map<string, PlayerWeekStats>(
    stats.map((row) => [key(row.playerId, row.week), row]),
  );
  const out: Standing[] = [];

  for (const appearance of rosters) {
    const { playerId, week } = appearance;

    if (week < FIRST_WEEK || week > LAST_WEEK) {
      continue;
    }

    const played = (byPlayer.get(playerId) ?? []).filter((r) => r.week < week);
    const window = played.slice(-RECENT_GAMES);

    if (window.length < RECENT_GAMES) {
      continue;
    }

    const row = rowAt.get(key(playerId, week));
    const position = row?.position ?? appearance.rawPosition;

    if (!POSITIONS.includes(position)) {
      continue;
    }

    out.push({
      playerId,
      teamId: row?.teamId ?? appearance.teamId,
      position,
      week,
      recent: window.reduce((s, r) => s + touches(r), 0) / window.length,
      actual: row ? touches(row) : 0,
    });
  }

  return out;
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--season");
  const season = flag === -1 ? 2025 : Number(process.argv[flag + 1]);
  const rosters = await loadWeeklyRosters(season);
  const men = standings(rosters, await loadPlayerStats(season));
  const injuries = await loadWeeklyInjuryStatus(season);
  const inactive = new Set<string>();

  for (const row of rosters) {
    if (row.status === INACTIVE) {
      inactive.add(key(row.playerId, row.week));
    }
  }

  const surprise = (at: string) =>
    inactive.has(at) && injuries.get(at)?.out !== true;

  // A man who rose gains from somebody else being out, so what the
  // inactive list tells us about him is who was missing from his room.
  const roomShort = new Set<string>();
  const roomOut = new Set<string>();
  const roomKey = (man: Standing) =>
    `${man.teamId}|${man.position}|${man.week}`;

  for (const man of men) {
    const at = key(man.playerId, man.week);

    if (surprise(at)) {
      roomShort.add(roomKey(man));
    }

    if (injuries.get(at)?.out === true) {
      roomOut.add(roomKey(man));
    }
  }

  const byDirection: Record<Direction, Counts> = {
    fell: emptyCounts(),
    rose: emptyCounts(),
  };
  let eligible = 0;

  for (const man of men) {
    if (man.recent < HAS_A_JOB) {
      continue;
    }

    eligible++;
    const direction = directionOf(man.recent, man.actual);

    if (!direction) {
      continue;
    }

    const at = key(man.playerId, man.week);
    const counts = byDirection[direction];
    counts.weeks++;

    // A man who rose because his club had already ruled a room-mate out
    // is a week our own numbers see coming, since the volume model
    // hands that room-mate's touches to whoever is left.
    const fridayKnew =
      injuries.get(at)?.out === true ||
      (direction === "rose" && roomOut.has(roomKey(man)));

    if (fridayKnew) {
      counts.fridayKnew++;
      continue;
    }

    const caught =
      direction === "fell"
        ? inactive.has(at)
        : roomShort.has(roomKey(man));

    if (caught) {
      counts.inactiveCatches++;
    } else {
      counts.neither++;
    }
  }

  const total: Counts = {
    weeks: byDirection.fell.weeks + byDirection.rose.weeks,
    fridayKnew: byDirection.fell.fridayKnew + byDirection.rose.fridayKnew,
    inactiveCatches:
      byDirection.fell.inactiveCatches + byDirection.rose.inactiveCatches,
    neither: byDirection.fell.neither + byDirection.rose.neither,
  };

  console.log(
    `${season}, weeks ${FIRST_WEEK} to ${LAST_WEEK}: ${eligible} player-weeks at ` +
      `RB, WR or TE where the man was already getting ${HAS_A_JOB} touches a game`,
  );
  console.log(
    `${total.weeks} of them are job-change weeks, his touches more than double ` +
      "or less than half\n",
  );
  report("his touches fell away", byDirection.fell);
  report("his touches doubled", byDirection.rose);
  report("both directions", total);
  console.log(
    `\n${inactive.size} inactive player-weeks in the ${season} roster file, ` +
      `${[...inactive].filter(surprise).length} of them a man the friday ` +
      "report had not ruled out",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

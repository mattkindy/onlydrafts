/**
 * How long each stage of the waiver page's season pricing takes, on the
 * board that ships in docs/data.
 *
 * The page draws a year of weeks for the whole board and then prices
 * every man on the wire off one baseline, so a change to the draws or
 * to the drop side shows up here before anybody opens a phone.
 *
 * Run: npx tsx scripts/timeWaivers.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rescore } from "../app/lib/board.ts";
import { loadBoard, loadMeta } from "../app/lib/data.ts";
import { roomFor } from "../app/lib/draftShare.ts";
import {
  addsFor, dropsFor, netsFor, openSpotsFor,
} from "../app/lib/waivers.ts";
import { weekPricesFor } from "../app/lib/waiversWeek.ts";
import { barsOf, baselineFor, weeksOf } from "../app/lib/winShare.ts";
import { loadSlate, weekRefs } from "../app/lib/slate.ts";
import { normalizeName } from "../app/lib/store.ts";

const DATA = join(process.cwd(), "docs", "data");

// the board is fetched in the browser, so the files stand in for a server
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const name = String(url).split("/").pop()!.split("?")[0]!;

  return {
    ok: true,
    json: async () => JSON.parse(readFileSync(join(DATA, name), "utf8")),
  };
};

const meta = await loadMeta();
const board = await loadBoard(meta.boardSeason);
const slots = [
  "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF",
  "BN", "BN", "BN", "BN", "BN", "BN",
];
const men = rescore(
  board.players, { teams: 12, slots, pays: { rec: 0.5 } }, board.schedule);

const t = <T>(label: string, f: () => T): T => {
  const at = performance.now();
  const out = f();
  console.log(label.padEnd(28), (performance.now() - at).toFixed(0), "ms");

  return out;
};

const byPos = (pos: string, n: number, skip = 0) =>
  men
    .filter((p) => p.position === pos)
    .sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0))
    .slice(skip, skip + n);
const mine = [
  ...byPos("QB", 1, 3), ...byPos("RB", 5, 2), ...byPos("WR", 5, 4),
  ...byPos("TE", 2, 3), ...byPos("K", 1, 2), ...byPos("DEF", 1, 4),
];
const rostered = new Set<string>();

for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
  for (const p of byPos(pos, pos === "RB" || pos === "WR" ? 60 : 14)) {
    rostered.add(p.key);
  }
}

const pool = men.filter((p) => !rostered.has(p.key));
console.log("board", men.length, "pool", pool.length);

// the order the page runs them in, with nobody's weeks drawn yet
const room = t("roomFor", () => roomFor(men, slots, 12, 2000, null));
const adds = t("addsFor", () => addsFor(mine, pool, slots, room));
t("dropsFor", () => dropsFor(mine, slots, room));
const open = openSpotsFor(slots, mine.length);
t("netsFor x12", () => netsFor(mine, adds.slice(0, 12), slots, room, open));
t("draw every man", () => men.forEach((p) => weeksOf(p, 2000)));

const bars = barsOf(baselineFor(mine, slots, 2000, room.wire));
const under = pool.filter((p) => (p.ppg ?? 0) < (bars[p.position] ?? 0));
console.log(
  "bars",
  Object.entries(bars).map(([at, n]) => `${at} ${n.toFixed(1)}`).join("  "));
console.log("pool skipped", under.length, "of", pool.length);

/**
 * The other half of the page: this week's own game, against a side of
 * the same shape put together off the same slate.
 */
const weeks = weekRefs(meta.weeks, meta.boardSeason);
const latest = weeks[weeks.length - 1];

if (latest) {
  const slate = await loadSlate(latest.file);
  const rows = new Map(slate.rows.map((r) => [normalizeName(r.name), r]));
  const seats = slots.filter((slot) => slot !== "BN");
  const sideOf = (roster: typeof mine, owner: string) => ({
    owner,
    points: 0,
    starters: roster.slice(0, seats.length)
      .map((p, i) => ({ key: p.key, slot: seats[i]!, points: 0 })),
    bench: roster.slice(seats.length).map((p) => ({ key: p.key, points: 0 })),
  });
  const theirs = [
    ...byPos("QB", 1, 4), ...byPos("RB", 5, 7), ...byPos("WR", 5, 9),
    ...byPos("TE", 2, 5), ...byPos("K", 1, 3), ...byPos("DEF", 1, 5),
  ];
  const lines = new Map(men.map((p) => [p.key, p]));

  t("weekPricesFor x12", () => weekPricesFor(
    {
      side: sideOf(mine, "me"),
      against: sideOf(theirs, "them"),
      slots,
      rows,
      states: new Map(),
      lines,
    },
    adds.slice(0, 12).map((a) => ({ p: a.p, drop: mine[mine.length - 1]! })),
  ));
}

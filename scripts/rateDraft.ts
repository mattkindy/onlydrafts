/**
 * How a Sleeper draft went, from the shell.
 *
 * The same rating the site shows, run against a live league so it can
 * be checked without a browser. Every team is scored against what its
 * own picks were worth, then the one you name is walked through pick
 * by pick.
 *
 * Run: npx tsx scripts/rateDraft.ts <sleeper name> [part of a league name]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rescore } from "../app/lib/board.js";
import { normalizeName } from "../app/lib/store.js";
import type { Pays, Player } from "../app/lib/scoring.js";
import {
  gradesFor, keyForPick, marketCurve, ratePicks, rateTeams, worthOf,
} from "../app/lib/draftRating.js";

const WHO = process.argv[2] ?? "mattkindy";
const WANTED = process.argv[3] ?? "";
const SLEEPER = "https://api.sleeper.app/v1";

const get = async <T>(at: string): Promise<T> =>
  fetch(`${SLEEPER}${at}`).then((r) => r.json() as Promise<T>);

const user = await get<{ user_id: string }>(`/user/${WHO}`);
const leagues = await get<{
  league_id: string; name: string; status: string; draft_id: string;
  total_rosters: number; roster_positions: string[];
  scoring_settings: Record<string, number>;
}[]>(`/user/${user.user_id}/leagues/nfl/2026`);
const league = leagues.find((l) =>
  (WANTED ? l.name.toLowerCase().includes(WANTED.toLowerCase()) : true) &&
  l.status !== "pre_draft");

if (!league) {
  console.log(
    `no drafted 2026 league for ${WHO}` +
    (WANTED ? ` matching "${WANTED}"` : "") +
    `. Found: ${leagues.map((l) => `${l.name} (${l.status})`).join(", ")}`,
  );
  process.exit(0);
}

const [picks, rosters, members] = await Promise.all([
  get<{
    pick_no: number; picked_by: string; is_keeper: boolean | null;
    metadata: {
      first_name: string; last_name: string; position: string; team: string;
    };
  }[]>(`/draft/${league.draft_id}/picks`),
  get<{ owner_id: string; players: string[] }[]>(`/league/${league.league_id}/rosters`),
  get<{ user_id: string; display_name: string }[]>(`/league/${league.league_id}/users`),
]);

const named = new Map(members.map((m) => [m.user_id, m.display_name]));
const file = JSON.parse(await readFile(
  join(import.meta.dirname, "..", "docs", "data", "board-2026.json"), "utf8",
)) as { players: Player[] };
const board = rescore(file.players, {
  teams: league.total_rosters,
  slots: league.roster_positions,
  pays: league.scoring_settings as unknown as Pays,
});
const byKey = new Map(board.map((p) => [p.key, p]));
const curve = marketCurve(board);

/**
 * A keeper was not drafted, whatever slot it came in at, so it is left
 * out of the rating along with the pick it used.
 */
const asPick = (pick: typeof picks[number]) => ({
  name: `${pick.metadata.first_name} ${pick.metadata.last_name}`,
  position: pick.metadata.position,
  team: pick.metadata.team,
});

/** each side's men paired with the picks that bought them */
const mine = new Map<string, { at: number; p: Player }[]>();
const lost: string[] = [];

for (const pick of picks) {
  if (pick.is_keeper) {
    continue;
  }

  const who = named.get(pick.picked_by) ?? pick.picked_by;
  const p = byKey.get(keyForPick(asPick(pick), normalizeName));

  if (p) {
    mine.set(who, [...(mine.get(who) ?? []), { at: pick.pick_no, p }]);
  } else {
    lost.push(asPick(pick).name);
  }
}

const rated = rateTeams(
  [...mine.entries()].map(([owner, took]) => ({ owner, took })),
  league.roster_positions,
  curve,
);
const grades = gradesFor(rated);

console.log(
  `${league.name}, ${league.total_rosters} teams, ` +
  `${picks.length} picks, ${league.roster_positions.join("/")}\n` +
  `scoring a catch at ${league.scoring_settings["rec"] ?? 0}, ` +
  `${picks.filter((p) => p.is_keeper).length} keepers left out` +
  (lost.length ? `\nnot on the board, so left out: ${lost.join(", ")}` : "") +
  `\n`,
);
console.log("  # team                 grade    over     got   slots  best three");

for (const [i, team] of rated.entries()) {
  const said = team.over >= 0
    ? `+${team.over.toFixed(1)}`
    : team.over.toFixed(1);
  console.log(
    `${String(i + 1).padStart(3)} ${team.owner.slice(0, 20).padEnd(20)} ` +
    `${(grades.get(team.owner) ?? "C").padEnd(5)} ${said.padStart(7)} ` +
    `${team.got.toFixed(1).padStart(7)} ${team.expected.toFixed(1).padStart(7)}  ` +
    team.starters.slice(0, 3).map((s) => s.p.name).join(", "),
  );
}

const own = picks
  .filter((pick) => !pick.is_keeper && (named.get(pick.picked_by) ?? "") === WHO)
  .map((pick) => ({
    at: pick.pick_no,
    p: byKey.get(keyForPick(asPick(pick), normalizeName)),
  }))
  .filter((x): x is { at: number; p: Player } => Boolean(x.p));

console.log(`\n${WHO}, pick by pick:`);
console.log("  pick  player                  pos   room had  waited     over");

for (const pick of ratePicks(own, curve)) {
  const round = Math.ceil(pick.at / league.total_rosters);
  const waited = pick.waited === null
    ? ""
    : pick.waited > 0
    ? `${pick.waited.toFixed(0)} late`
    : `${(-pick.waited).toFixed(0)} early`;
  console.log(
    `  ${String(round).padStart(2)}.${String(
      ((pick.at - 1) % league.total_rosters) + 1).padStart(2, "0")}  ` +
    `${pick.p.name.slice(0, 22).padEnd(22)} ${pick.p.position.padEnd(4)}  ` +
    `${(pick.adp === null ? "unpriced" : pick.adp.toFixed(0)).padStart(8)}  ` +
    `${waited.padEnd(9)} ` +
    `${(pick.over >= 0 ? "+" : "") + pick.over.toFixed(1)}`,
  );
}

const worst = own
  .map(({ at, p }) => ({ p, at, over: worthOf(p, curve) }))
  .sort((a, b) => a.over - b.over);

console.log(
  `\nthe two your lineup leans on least: ` +
  worst.slice(0, 2).map((w) => w.p.name).join(", "),
);

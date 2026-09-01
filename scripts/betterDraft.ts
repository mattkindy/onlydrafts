/**
 * The draft you could have had, walked turn by turn.
 *
 * At each turn it takes whoever adds most to the weeks you win, given
 * who is gone and the roster the run has built. Taking Nacua third
 * changes what is worth having at twenty seven, so this is walked
 * rather than read off a list.
 *
 * Everyone else keeps the picks they made, which is not quite fair:
 * had you taken a man somebody else wanted, they would have taken
 * someone else and the board would have moved.
 *
 * Run: npx tsx scripts/betterDraft.ts <sleeper username> [league]
 */

import { readFileSync } from "node:fs";

import { rescore } from "../app/lib/board.ts";
import { normalizeName } from "../app/lib/store.ts";
import { keyForPick, marketCurve, worthAt, worthOf } from "../app/lib/draftRating.ts";
import {
  baselineFor, projectedRoster, typicalWeek, winChance, winShareFor,
} from "../app/lib/winShare.ts";
import type { Player } from "../app/lib/scoring.ts";

const [who = "mattkindy", wanted = "Mildred"] = process.argv.slice(2);
const SEASON = 2026;

const ask = async (path: string) => {
  const said = await fetch("https://api.sleeper.app/v1" + path);

  if (!said.ok) {
    throw new Error(`sleeper said ${said.status} to ${path}`);
  }

  return await said.json() as any;
};

const file = JSON.parse(
  readFileSync("docs/data/board-2026.json", "utf8"),
) as { players: Record<string, unknown>[] };

const boardPlayers = file.players.map((row) => ({
  name: row["name"], key: row["key"], position: row["position"],
  team: row["team"] ?? null,
  projected: row["projected"] ?? null, simulated: row["simulated"] ?? null,
  weeks: row["weeks"] ?? [], adp: row["adp"] ?? null,
  adpLow: row["adpLow"] ?? null, adpHigh: row["adpHigh"] ?? null,
  adpBy: row["adpBy"] ?? null, bye: row["bye"] ?? null,
  touches: row["touches"] ?? null, rookie: row["rookie"] ?? false,
  game: row["game"] ?? null, sim: row["sim"] ?? null, ppg: row["ppg"] ?? 0,
})) as unknown as Player[];

const user = await ask(`/user/${who}`);
const leagues = await ask(`/user/${user.user_id}/leagues/nfl/${SEASON}`);
const league = leagues.find((l: any) =>
  l.name.toLowerCase().includes(wanted.toLowerCase()));

if (!league) {
  throw new Error(`no league matching ${wanted}`);
}

const [users, rosters, drafts, everyone] = await Promise.all([
  ask(`/league/${league.league_id}/users`),
  ask(`/league/${league.league_id}/rosters`),
  ask(`/league/${league.league_id}/drafts`),
  ask("/players/nfl"),
]);

const nameOf = new Map<string, string>(
  users.map((u: any) => [u.user_id, u.display_name ?? u.user_id]),
);
const picks = (await ask(`/draft/${drafts[0].draft_id}/picks`))
  .sort((a: any, b: any) => a.pick_no - b.pick_no);

/** what the league pays, in the words the scorer uses */
const pays: Record<string, number> = {};
const SAID: Record<string, string> = {
  rec: "rec", rec_yd: "rec_yd", rec_td: "rec_td",
  rush_yd: "rush_yd", rush_td: "rush_td",
  pass_yd: "pass_yd", pass_td: "pass_td", pass_int: "int",
  fum_lost: "fum_lost", sack: "sack", int: "int", fum_rec: "fum_rec",
  def_td: "def_td", safe: "safe", blk_kick: "blk_kick",
  pts_allow_0: "pts_allow_0", pts_allow_1_6: "pts_allow_1_6",
  pts_allow_7_13: "pts_allow_7_13", pts_allow_14_20: "pts_allow_14_20",
  pts_allow_21_27: "pts_allow_21_27", pts_allow_28_34: "pts_allow_28_34",
  pts_allow_35p: "pts_allow_35p",
};

for (const [said, ours] of Object.entries(SAID)) {
  const n = league.scoring_settings?.[said];

  if (n !== undefined) {
    pays[ours] = n;
  }
}

const slots = (league.roster_positions ?? null) as string[] | null;
const men = rescore(boardPlayers, {
  teams: league.total_rosters,
  slots,
  pays,
  rosters: rosters.map((r: any) => ({
    owner: nameOf.get(r.owner_id) ?? r.owner_id,
    picks: [] as number[],
    keys: (r.players ?? []).map((id: string) => everyone[id]).filter(Boolean)
      .map((p: any) => ({
        name: p.full_name ?? p.last_name,
        key: normalizeName(p.full_name ?? p.last_name),
        pos: p.position,
      })),
  })),
});

const byKey = new Map(men.map((p) => [p.key, p]));
const curve = marketCurve(men);
const opponent = typicalWeek(men, slots, league.total_rosters);

const manFor = (pick: any): Player | null => {
  const said = everyone[pick.player_id];

  if (!said) {
    return null;
  }

  return byKey.get(keyForPick(
    {
      name: said.full_name ?? said.last_name,
      position: said.position,
      team: said.team,
    },
    normalizeName,
  )) ?? null;
};

/**
 * A keeper is nobody's decision on draft night. Everyone knew before
 * the first pick who was kept, so they come off the board now rather
 * than when the draft reaches their slot, and your own sit on your
 * roster from the start. Counting them as picks had Smith-Njigba
 * offered as the better man at pick three, when Sprg had kept him.
 */
const kept = picks.filter((k: any) => k.is_keeper);
const taken = new Set<string>();
const mine: Player[] = [];

for (const k of kept) {
  const p = manFor(k);

  if (!p) {
    continue;
  }

  taken.add(p.key);

  if ((nameOf.get(k.picked_by) ?? k.picked_by) === who) {
    mine.push(p);
  }
}

console.log(
  `${kept.length} kept league wide, ${mine.length} of them yours: ` +
  `${mine.map((p) => p.name).join(", ")}\n`,
);

/** the turns where you actually chose somebody */
const myTurns: number[] = picks
  .filter((k: any) =>
    !k.is_keeper && (nameOf.get(k.picked_by) ?? k.picked_by) === who)
  .map((k: any) => k.pick_no);


console.log("pick  you took              could have taken      gains");

/** the board in the order a room drafts it */
const byAdp = men.filter((p) => p.adp).sort((a, b) => a.adp! - b.adp!);
const actual = [...mine];

for (const pick of picks) {
  if (pick.is_keeper) {
    continue;
  }

  const p = manFor(pick);
  const owner = nameOf.get(pick.picked_by) ?? pick.picked_by;

  /**
   * The room takes the best man left by draft position rather than the
   * man it took on the night. Holding the others to what they did means
   * anybody you pass on is never taken by anyone: pass on Cook at three
   * and he is still sitting there in the fourth, because none of them
   * had him written down after you took him.
   */
  if (owner !== who) {
    const next = byAdp.find((o) => !taken.has(o.key));

    if (next) {
      taken.add(next.key);
    } else if (p) {
      taken.add(p.key);
    }

    continue;
  }

  const left = men.filter((o) => !taken.has(o.key));
  const toCome = myTurns.filter((n) => n > pick.pick_no);
  const worth = winShareFor(
    baselineFor(projectedRoster(mine, slots, left, toCome), slots),
    opponent,
  );
  const best = left
    .map((o) => ({ o, added: worth(o).added }))
    .sort((a, b) => b.added - a.added)[0]!;

  if (p) {
    actual.push(p);
  }

  console.log(
    `${String(pick.pick_no).padStart(4)}  ` +
    `${(p ? `${p.name} (${p.position})` : "nobody").padEnd(21)} ` +
    `${`${best.o.name} (${best.o.position})`.padEnd(21)} ` +
    `${(best.added * 100).toFixed(2).padStart(5)}%` +
    (p && best.o.key === p.key ? "   you took him" : ""),
  );

  // the run goes on from the man it would have taken, not from yours
  mine.push(best.o);
  taken.add(best.o.key);
}

const weekly = (roster: Player[]) =>
  winChance(baselineFor(roster, slots).total, opponent);

console.log(
  `\nthe side you drafted wins ${(weekly(actual) * 100).toFixed(1)}% of weeks` +
  ` against a middling one`,
);
console.log(`the side above wins       ${(weekly(mine) * 100).toFixed(1)}%\n`);

for (const [what, roster] of [["yours", actual], ["the other", mine]] as const) {
  console.log(
    `${what}:\n  ${[...roster]
      .sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0))
      .map((p) => `${p.name} (${p.position})`).join("\n  ")}\n`,
  );
}

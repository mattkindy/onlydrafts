/**
 * Every pick of one draft, judged by each measure we have.
 *
 * The point is that they disagree. What the room paid says whether he
 * was a bargain, what a pick at that place is worth says whether the
 * slot was spent well, and what he adds to the weeks you win is the
 * only one that knows what was already on your roster when you took
 * him. That last one is walked forward pick by pick, so the seventh
 * round is judged against the six rounds you had already made.
 *
 * Run: npx tsx scripts/myPicksEval.ts <sleeper username> [league name]
 */

import { readFileSync } from "node:fs";

import { rescore } from "../app/lib/board.ts";
import { normalizeName } from "../app/lib/store.ts";
import { keyForPick, marketCurve, worthAt, worthOf } from "../app/lib/draftRating.ts";
import {
  baselineFor, projectedRoster, typicalWeek, winShareFor,
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

console.log(`${league.name}, ${who}, pick by pick\n`);
console.log(
  "pick  player                pos  fell   market   board    par" +
  "   weeks   starts  better still there",
);

const myTurns: number[] = picks
  .filter((k: any) => (nameOf.get(k.picked_by) ?? k.picked_by) === who)
  .map((k: any) => k.pick_no);
const taken = new Set<string>();
const mine: Player[] = [];

for (const pick of picks) {
  const p = manFor(pick);
  const owner = nameOf.get(pick.picked_by) ?? pick.picked_by;

  if (!p) {
    taken.add(pick.player_id);
    continue;
  }

  if (owner !== who) {
    taken.add(p.key);
    continue;
  }

  /**
   * The board as it was when he was on the clock, and his roster as it
   * then stood, so the weeks he adds are the weeks he would have added.
   */
  const left = men.filter((o) => !taken.has(o.key));
  /**
   * Against the side you would have finished with, not the handful you
   * had at the time. One man against a whole team loses every week, so
   * a partial roster reads nought for everybody, and an empty seat
   * looks enormous when a late round would fill it nearly as well.
   */
  const toCome = myTurns.filter((n) => n > pick.pick_no);
  const worth = winShareFor(
    baselineFor(projectedRoster(mine, slots, left, toCome), slots),
    opponent,
  );
  const his = worth(p);
  const ranked = left
    .map((o) => ({ o, its: worth(o) }))
    .sort((a, b) => b.its.added - a.its.added);
  const best = ranked[0]!;
  const fell = p.adp ? pick.pick_no - p.adp : null;

  console.log(
    `${String(pick.pick_no).padStart(4)}  ${p.name.padEnd(21)}` +
    ` ${p.position.padEnd(4)}` +
    ` ${(fell === null ? "-" : fell.toFixed(0)).padStart(4)}` +
    ` ${(worthOf(p, curve) - worthAt(curve, pick.pick_no)).toFixed(1).padStart(8)}` +
    ` ${(p.vor ?? 0).toFixed(1).padStart(7)}` +
    ` ${(p.ownVor ?? 0).toFixed(1).padStart(6)}` +
    ` ${(his.added * 100).toFixed(2).padStart(6)}%` +
    ` ${(his.starts * 100).toFixed(0).padStart(6)}%` +
    `  ${best.o.key === p.key
      ? "he was the best"
      : `${best.o.name} ${(best.its.added * 100).toFixed(2)}%`}`,
  );

  taken.add(p.key);
  mine.push(p);
}

console.log(
  "\nmarket: what the room paid for the slot against what he cost." +
  "\nboard: what a pick at his place is worth." +
  "\npar: what he beats the last man your league starts by." +
  "\nweeks: what he added to how often you win, with the roster you had." +
  "\nbetter still there: who would have added more at that moment.",
);

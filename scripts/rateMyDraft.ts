/**
 * Grade a finished Sleeper draft against the board as it is now.
 *
 * The draft is read live rather than kept in a file, so re-running this
 * after a change to how players are valued shows what the change did to
 * the grades. Every team is measured against what its own picks should
 * have bought, so picking third is not itself worth anything.
 *
 * Run: npx tsx scripts/rateMyDraft.ts <sleeper username> [league name]
 */

import { readFileSync } from "node:fs";

import { rescore } from "../app/lib/board.ts";
import { normalizeName } from "../app/lib/store.ts";
import {
  barFromPicks, gradesFor, keyForPick, marketCurve, rateTeams, ratePicks,
} from "../app/lib/draftRating.ts";
import type { Player } from "../app/lib/scoring.ts";

const [who = "mattkindy", wanted] = process.argv.slice(2);
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
const league = wanted
  ? leagues.find((l: any) => l.name.toLowerCase().includes(wanted.toLowerCase()))
  : leagues[0];

if (!league) {
  throw new Error(`no league for ${who}: ${leagues.map((l: any) => l.name)}`);
}

console.log(`${league.name}, ${league.total_rosters} teams\n`);

const [users, rosters, drafts, everyone] = await Promise.all([
  ask(`/league/${league.league_id}/users`),
  ask(`/league/${league.league_id}/rosters`),
  ask(`/league/${league.league_id}/drafts`),
  ask("/players/nfl"),
]);

const nameOf = new Map<string, string>(
  users.map((u: any) => [u.user_id, u.display_name ?? u.user_id]),
);

const picks = await ask(`/draft/${drafts[0].draft_id}/picks`);

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

const asRoster = rosters.map((r: any) => ({
  owner: nameOf.get(r.owner_id) ?? r.owner_id,
  picks: [] as number[],
  keys: (r.players ?? [])
    .map((id: string) => everyone[id])
    .filter(Boolean)
    .map((p: any) => ({
      name: p.full_name ?? p.last_name,
      key: normalizeName(p.full_name ?? p.last_name),
      pos: p.position,
    })),
}));

const men = rescore(boardPlayers, {
  teams: league.total_rosters,
  slots: league.roster_positions ?? null,
  pays,
  rosters: asRoster,
});

const byKey = new Map(men.map((p) => [p.key, p]));

const took = new Map<string, { at: number; p: Player }[]>();

for (const pick of picks) {
  const said = everyone[pick.player_id];

  if (!said) {
    continue;
  }

  const key = keyForPick(
    {
      name: said.full_name ?? said.last_name,
      position: said.position,
      team: said.team,
    },
    normalizeName,
  );
  const p = byKey.get(key);
  const owner = nameOf.get(pick.picked_by) ?? pick.picked_by;

  if (!p) {
    console.log(`  (no board row for ${said.full_name ?? said.last_name})`);
    continue;
  }

  took.set(owner, [...(took.get(owner) ?? []), { at: pick.pick_no, p }]);
}

const curve = marketCurve(men);
/** the men who were kept, so the simulated room does not draft them */
const kept = picks
  .filter((k: any) => k.is_keeper)
  .map((k: any) => {
    const said = everyone[k.player_id];

    return said
      ? {
        key: keyForPick(
          {
            name: said.full_name ?? said.last_name,
            position: said.position,
            team: said.team,
          },
          normalizeName,
        ),
        at: k.pick_no as number,
      }
      : null;
  })
  .filter(Boolean) as { key: string; at: number }[];
/** every pick the room made, which is the bar each of them is judged against */
const everyMade = [...took].flatMap(([, its]) => its);
const bar = barFromPicks(everyMade, curve, 260);
const rated = rateTeams(
  [...took].map(([owner, its]) => ({ owner, took: its })),
  league.roster_positions ?? null,
  curve,
  bar,
);
const grades = gradesFor(rated);

console.log("team".padEnd(20) + "grade".padEnd(7) + "per pick".padStart(9) +
  "  picks");

for (const team of rated) {
  console.log(
    team.owner.padEnd(20) +
    (grades.get(team.owner) ?? "").padEnd(7) +
    team.perPick.toFixed(2).padStart(9) +
    `  ${team.picks}`,
  );
}

/** the picks that moved most, so a change to the board is visible */
const mine = took.get(who);

if (mine) {
  console.log(`\n${who}, pick by pick\n`);

  for (const r of ratePicks([...mine].sort((a, b) => a.at - b.at), curve, bar)) {
    console.log(
      `  ${String(r.at).padStart(3)} ${r.p.name.padEnd(22)}` +
      ` ${r.p.position.padEnd(4)}` +
      ` over ${r.over.toFixed(1).padStart(7)}` +
      (r.fell === null ? "" : `  ${r.fell >= 0 ? "fell" : "reached"} ` +
        `${Math.abs(r.fell)}`),
    );
  }
}

console.log("\nwhere a kicker or a defence went\n");

for (const [owner, its] of took) {
  for (const { at, p } of its) {
    if (p.position === "K" || p.position === "DEF") {
      console.log(
        `  ${String(at).padStart(3)} ${p.name.padEnd(20)} ${p.position.padEnd(4)}` +
        ` ${owner.padEnd(18)} par ${(p.ownVor ?? 0).toFixed(1).padStart(7)}`,
      );
    }
  }
}

/**
 * How big a surplus a pick can produce, by where it falls. A late pick
 * is expected to buy nothing, so finding a starter there scores far
 * more than beating an early pick's high bar ever can, and a team with
 * more late turns collects more surplus without drafting better.
 */
const everyPick = [...took].flatMap(([, its]) => ratePicks(its, curve, bar));
const BUCKETS: [string, number, number][] = [
  ["1 to 24", 1, 24], ["25 to 60", 25, 60], ["61 to 96", 61, 96],
  ["97 to 132", 97, 132], ["133 and later", 133, 999],
];

console.log("\nspread of surplus by where the pick fell\n");

for (const [label, from, to] of BUCKETS) {
  const its = everyPick.filter((r) => r.at >= from && r.at <= to);

  if (!its.length) {
    continue;
  }

  const overs = its.map((r) => r.over);
  const mid = overs.reduce((s, n) => s + n, 0) / overs.length;
  const sd = Math.sqrt(
    overs.reduce((s, n) => s + (n - mid) ** 2, 0) / Math.max(1, overs.length - 1),
  );

  console.log(
    `  ${label.padEnd(15)} ${String(its.length).padStart(3)} picks` +
    `   mean ${mid.toFixed(1).padStart(6)}   spread ${sd.toFixed(1).padStart(6)}`,
  );
}

// how far men fell by where they went, which is what the surplus above
// is really measuring
console.log("\nhow far a man fell, by where the pick fell\n");

for (const [label, from, to] of BUCKETS) {
  const its = everyPick.filter((r) =>
    r.at >= from && r.at <= to && r.fell !== null);

  if (!its.length) {
    continue;
  }

  const fell = its.map((r) => r.fell!);
  const best = Math.max(...fell);

  console.log(
    `  ${label.padEnd(15)} mean ${(fell.reduce((s, n) => s + n, 0) / fell.length)
      .toFixed(1).padStart(6)}   best ${best.toFixed(0).padStart(4)}` +
    `   reaches ${fell.filter((n) => n < 0).length}/${fell.length}`,
  );
}

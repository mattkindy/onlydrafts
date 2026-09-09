/**
 * One drafter's turns, replayed against the board he was reading, so a
 * number he doubts can be taken apart.
 *
 * At each turn it rebuilds who was gone, who was left, what he already
 * had and which turns he had coming, then asks takeNowFor for the ten
 * men it liked best and says where his own pick came in that order.
 *
 * It also prints the rest of the draft the model assumed for him and how
 * often each seat came up empty in the drawn weeks, since a win chance
 * is built out of those.
 *
 * Run: npx tsx scripts/draftWalk.ts [draftId] [leagueId] [cacheDir]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rescore } from "../app/lib/board.ts";
import { keyForPick } from "../app/lib/draftRating.ts";
import { offWaivers } from "../app/lib/replacementPool.ts";
import { normalizeName } from "../app/lib/store.ts";
import { lineupOf, type Pays, type Player } from "../app/lib/scoring.ts";
import { DRAWS } from "../app/lib/spread.ts";
import {
  baselineFor, projectedRoster, takeNowFor, typicalWeek, weeksOf, winChance,
  winShareFor, type Baseline,
} from "../app/lib/winShare.ts";

const [
  draftId = "1389722824846880769",
  leagueId = "1389722824846880768",
  cacheDir = join(tmpdir(), "draftWalk"),
] = process.argv.slice(2);
const ME = "632473674548580352";
const WHERE = ["QB", "RB", "WR", "TE", "K", "DEF"];

mkdirSync(cacheDir, { recursive: true });

/** the api once, then off disk, since a draft that is over never moves */
async function cached(name: string, path: string): Promise<any> {
  const file = join(cacheDir, name + ".json");

  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    const said = await fetch("https://api.sleeper.app/v1" + path);

    if (!said.ok) {
      throw new Error(`sleeper said ${said.status} to ${path}`);
    }

    const body = await said.json();
    writeFileSync(file, JSON.stringify(body));

    return body;
  }
}

interface Pick {
  pick_no: number;
  round: number;
  picked_by: string;
  metadata: { first_name: string; last_name: string; position: string; team: string };
}

const picks = (await cached("picks", `/draft/${draftId}/picks`) as Pick[])
  .sort((a, b) => a.pick_no - b.pick_no);
const league = await cached("league", `/league/${leagueId}`);

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

/**
 * What the league pays, straight across, which is what the app does with
 * a Sleeper league. Half a point a catch and six for a passing td here.
 */
const pays = (league.scoring_settings ?? {}) as Pays;
const slots = (league.roster_positions ?? null) as string[] | null;
const teams: number = league.total_rosters;
const men = rescore(boardPlayers, { teams, slots, pays, rosters: null });
const byKey = new Map(men.map((p) => [p.key, p]));

const manFor = (pick: Pick): Player | null =>
  byKey.get(keyForPick(
    {
      name: `${pick.metadata.first_name} ${pick.metadata.last_name}`,
      position: pick.metadata.position,
      team: pick.metadata.team,
    },
    normalizeName,
  )) ?? null;

const took = picks.map((pick) => ({ pick, p: manFor(pick) }));
const missed = took.filter((t) => !t.p);

if (missed.length) {
  console.log(
    `not on the board: ${missed.map((t) =>
      `${t.pick.pick_no} ${t.pick.metadata.last_name}`).join(", ")}\n`,
  );
}

const wentAt = new Map<string, number>();

for (const { pick, p } of took) {
  if (p) {
    wentAt.set(p.key, pick.pick_no);
  }
}

const mine = took.filter((t) => t.pick.picked_by === ME);
const turnsAll = mine.map((t) => t.pick.pick_no);
const opponent = typicalWeek(men, slots, teams, DRAWS);
const seats = lineupOf(slots);

console.log(
  `${league.name}, ${teams} teams, ${pays["rec"] ?? 0} a catch, ` +
  `${DRAWS} weeks drawn`,
);
console.log(
  `lineup ${JSON.stringify(seats.named)} plus ${seats.flex} flex, ` +
  `a typical week ${(opponent.reduce((s, n) => s + n, 0) / opponent.length)
    .toFixed(1)}\n`,
);

/** assumed fills the room had already taken by the turn they were penciled for */
const evaporated: string[] = [];

const at = (n: number) => n.toFixed(4).padStart(7);
const pct = (n: number) => (100 * n).toFixed(0).padStart(3) + "%";

/**
 * Which turn the fill spent on each man it assumed, got by asking for one
 * turn more at a time and seeing who arrived, so nothing here has to
 * repeat how projectedRoster chooses.
 */
function assumedAt(
  had: Player[], left: Player[], later: number[],
): { at: number; p: Player }[] {
  const out: { at: number; p: Player }[] = [];
  let before = new Set(had.map((p) => p.key));

  for (let n = 1; n <= later.length; n++) {
    const roster = projectedRoster(had, slots, left, later.slice(0, n));
    const now = new Set(roster.map((p) => p.key));

    for (const p of roster) {
      if (!before.has(p.key)) {
        out.push({ at: later[n - 1]!, p });
      }
    }

    before = now;
  }

  return out;
}

/** how often each seat had nobody in it, over the drawn weeks */
function openSeats(displaced: Record<string, { expect: number }[]>) {
  const out: string[] = [];

  for (const where of WHERE) {
    const its = displaced[where] ?? [];
    const empty = its.filter((d) => d.expect === 0).length;
    const filled = its.filter((d) => d.expect > 0);
    const mean = filled.length
      ? filled.reduce((s, d) => s + d.expect, 0) / filled.length
      : 0;
    out.push(`${where} open ${pct(empty / Math.max(1, its.length))} ` +
      `bar ${mean.toFixed(1)}`);
  }

  return out.join(", ");
}

for (let turn = 0; turn < mine.length; turn++) {
  const here = mine[turn]!;
  const pick = here.pick.pick_no;
  const gone = new Set(
    took.filter((t) => t.pick.pick_no < pick && t.p).map((t) => t.p!.key),
  );
  const had = mine.slice(0, turn).map((t) => t.p!).filter(Boolean);
  const left = men.filter((p) => !gone.has(p.key));
  const turns = turnsAll.slice(turn);
  const later = turns.slice(1);
  const assumed = projectedRoster(had, slots, left, later);
  const passed = baselineFor(assumed, slots, DRAWS);
  const without = winChance(passed.total, opponent);
  const worth = takeNowFor(had, slots, left, turns, opponent, DRAWS);

  const scored = left
    .map((p) => ({ p, ...worth(p) }))
    .sort((a, b) => b.added - a.added);
  const tally: Record<string, number> = {};

  for (const p of had) {
    tally[p.position] = (tally[p.position] ?? 0) + 1;
  }

  console.log(
    `=== r${here.pick.round} p${pick}, ${mine.length - turn} turns left, ` +
    `mine so far ${WHERE.map((w) => `${w}${tally[w] ?? 0}`).join(" ")}`,
  );
  console.log(
    `passing reads ${without.toFixed(4)} ` +
    `on a ${(passed.total.reduce((s, n) => s + n, 0) / passed.total.length)
      .toFixed(1)} point week`,
  );
  const plan = assumedAt(had, left, later);

  for (const a of plan) {
    const went = wentAt.get(a.p.key);

    if (went !== undefined && went < a.at) {
      const his = turnsAll.includes(went);
      evaporated.push(
        `r${here.pick.round} counted on ${a.p.name} at ${a.at}, ` +
        `${his ? "he took him himself" : "the room took him"} at ${went}`,
      );
    }
  }

  console.log(
    "    assumed later: " +
    (plan
      .map((a) => `at ${a.at} ${a.p.position} ${a.p.name} ` +
        `${(a.p.ppg ?? 0).toFixed(1)} (adp ${a.p.adp?.toFixed(0) ?? "none"}, ` +
        `went ${wentAt.get(a.p.key) ?? "undrafted"}, ` +
        `reads ${at(worth(a.p).added)})`)
      .join("; ") || "nothing, every seat filled"),
  );
  console.log("    seats: " + openSeats(passed.displaced));
  console.log(
    "   #  player                 pos   ppg  starts    added  went at",
  );

  for (let i = 0; i < 10; i++) {
    const row = scored[i]!;
    console.log(
      `  ${String(i + 1).padStart(2)}  ${row.p.name.padEnd(22)} ` +
      `${row.p.position.padEnd(3)} ${(row.p.ppg ?? 0).toFixed(1).padStart(5)} ` +
      `  ${pct(row.starts)}  ${at(row.added)}  ` +
      `${wentAt.get(row.p.key) ?? "-"}`,
    );
  }

  const his = scored.findIndex((s) => s.p.key === here.p!.key);
  const row = scored[his]!;
  console.log(
    `  he took ${row.p.name} ${row.p.position}, ` +
    `${(row.p.ppg ?? 0).toFixed(1)} a game, starts ${pct(row.starts)}, ` +
    `added ${at(row.added)}, ranked ${his + 1} of ${scored.length}`,
  );

  const bests = WHERE.map((where) => {
    const top = scored.find((s) => s.p.position === where)!;

    return `${where} ${top.p.name.split(" ").pop()} ${at(top.added)}`;
  });
  console.log("    best at each: " + bests.join(", "));

  for (const where of ["K", "DEF"]) {
    const its = scored.filter((s) => s.p.position === where);
    const under = its.filter((s) => s.added < 0).length;
    console.log(
      `    ${where}: ${under} of ${its.length} below nothing, best ` +
      `${at(its[0]!.added)} (${its[0]!.p.name}), worst ` +
      `${at(its[its.length - 1]!.added)}`,
    );
  }

  console.log("");
}

console.log("=== assumed fills the room had already taken");

for (const line of evaporated) {
  console.log("  " + line);
}

console.log("\n=== men with no adp, who the fill assumes are always there");
const noAdp = men.filter((p) => !p.adp).slice(0, 12);

for (const p of noAdp) {
  console.log(
    `  rank ${String(p.rank).padStart(3)} ${p.name.padEnd(22)} ` +
    `${p.position} ${(p.ppg ?? 0).toFixed(1)} a game`,
  );
}

console.log("\n=== kickers at his last two turns");
const kickerTurn = mine.length - 2;

for (const turn of [kickerTurn, kickerTurn + 1]) {
  const here = mine[turn]!;
  const gone = new Set(
    took.filter((t) => t.pick.pick_no < here.pick.pick_no && t.p)
      .map((t) => t.p!.key),
  );
  const had = mine.slice(0, turn).map((t) => t.p!);
  const left = men.filter((p) => !gone.has(p.key));
  const turns = turnsAll.slice(turn);
  const worth = takeNowFor(had, slots, left, turns, opponent, DRAWS);
  const kickers = left.filter((p) => p.position === "K")
    .sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0)).slice(0, 5);

  console.log(`  at p${here.pick.pick_no}:`);

  for (const k of kickers) {
    const his = worth(k);
    console.log(
      `    ${k.name.padEnd(20)} ${(k.ppg ?? 0).toFixed(1).padStart(5)} ` +
      `a game, starts ${pct(his.starts)}, added ${at(his.added)}`,
    );
  }
}

/**
 * The same turn with one thing changed: a week his starter is out costs
 * him the quarterback anybody can have off waivers rather than nothing.
 * Everything else, the draws and the rest of the roster, is untouched.
 */
function againstTheWire(
  base: Baseline, where: string, wire: number, wireWeeks: number[],
): Baseline {
  const bar = base.displaced[where]!.map((seat, i) =>
    seat.expect > 0 ? seat : { expect: wire, score: wireWeeks[i]! });

  return {
    total: base.total.map((week, i) =>
      week + (base.displaced[where]![i]!.expect > 0 ? 0 : wireWeeks[i]!)),
    displaced: { ...base.displaced, [where]: bar },
    started: base.started,
  };
}

console.log("\n=== a backup quarterback, against nothing and against the wire");
const backupTurn = 5;
{
  const here = mine[backupTurn]!;
  const gone = new Set(
    took.filter((t) => t.pick.pick_no < here.pick.pick_no && t.p)
      .map((t) => t.p!.key),
  );
  const had = mine.slice(0, backupTurn).map((t) => t.p!);
  const left = men.filter((p) => !gone.has(p.key));
  const base = baselineFor(
    projectedRoster(had, slots, left, turnsAll.slice(backupTurn + 1)),
    slots, DRAWS,
  );
  const wire = offWaivers(men, "QB", teams, null) ?? 0;
  const wireMan = men.filter((p) => p.position === "QB")
    .sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0))[teams]!;
  const patched = againstTheWire(base, "QB", wire, weeksOf(wireMan, DRAWS));
  const asIs = winShareFor(base, opponent, DRAWS);
  const fair = winShareFor(patched, opponent, DRAWS);

  console.log(
    `  at p${here.pick.pick_no}, the wire quarterback is ${wireMan.name} ` +
    `at ${wire.toFixed(1)} a game`,
  );

  for (const qb of left.filter((p) => p.position === "QB").slice(0, 6)) {
    const one = asIs(qb);
    const two = fair(qb);
    console.log(
      `    ${qb.name.padEnd(20)} ${(qb.ppg ?? 0).toFixed(1)} a game, ` +
      `starts ${pct(one.starts)} against nothing ${at(one.added)}, ` +
      `starts ${pct(two.starts)} against the wire ${at(two.added)}`,
    );
  }
}

console.log("\n=== the quarterbacks he took");
const qbs = mine.map((t) => t.p!).filter((p) => p.position === "QB");

for (const qb of qbs) {
  const weeks = weeksOf(qb, DRAWS);
  const out = weeks.filter((w) => w <= 0).length;
  console.log(
    `  ${qb.name.padEnd(20)} ${(qb.ppg ?? 0).toFixed(1)} a game, ` +
    `games ${qb.games}, out in ${pct(out / weeks.length)} of drawn weeks, ` +
    `mean when he plays ${(weeks.filter((w) => w > 0)
      .reduce((s, n) => s + n, 0) / Math.max(1, weeks.length - out)).toFixed(1)}`,
  );
}

const stafford = mine.find((t) => t.p!.name.includes("Stafford"));

if (stafford) {
  const turn = mine.indexOf(stafford);
  const gone = new Set(
    took.filter((t) => t.pick.pick_no < stafford.pick.pick_no && t.p)
      .map((t) => t.p!.key),
  );
  const had = mine.slice(0, turn).map((t) => t.p!);
  const left = men.filter((p) => !gone.has(p.key));
  const assumed = projectedRoster(had, slots, left, turnsAll.slice(turn + 1));
  const base = baselineFor(assumed, slots, DRAWS);
  const bar = base.displaced["QB"]!;
  const empty = bar.filter((d) => d.expect === 0).length;
  const him = weeksOf(stafford.p!, DRAWS);
  const beats = him.filter((w, i) =>
    w > 0 && (stafford.p!.ppg ?? 0) > bar[i]!.expect).length;
  console.log(
    `  the qb seat at p${stafford.pick.pick_no}: empty in ` +
    `${pct(empty / bar.length)} of weeks, and Stafford is expected to ` +
    `start ${pct(beats / him.length)}`,
  );
  console.log(
    `  of those starts, ${pct(bar.filter((d, i) =>
      d.expect === 0 && him[i]! > 0).length / Math.max(1, beats))} ` +
    `are weeks the seat was empty`,
  );
}

console.log("\n=== byes");
console.log(
  `  ${men.filter((p) => p.bye).length} of ${men.length} men carry a bye ` +
  `week, and weeksOf reads games and the drawn spread only.`,
);

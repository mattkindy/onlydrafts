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
import { offWaivers, waiverBar } from "../app/lib/replacementPool.ts";
import { normalizeName } from "../app/lib/store.ts";
import { lineupOf, payFor, type Pays, type Player } from "../app/lib/scoring.ts";
import { DRAWS as WEEKS } from "../app/lib/spread.ts";
import {
  baselineFor, projectedRoster, takeNowFor, typicalWeek, weeksOf, winChance,
  winShareFor,
} from "../app/lib/winShare.ts";

const [
  draftId = "1389722824846880769",
  leagueId = "1389722824846880768",
  cacheDir = join(tmpdir(), "draftWalk"),
] = process.argv.slice(2);
const ME = "632473674548580352";
const WHERE = ["QB", "RB", "WR", "TE", "K", "DEF"];
/**
 * Two thousand weeks resolve five ten-thousandths, and the top of the
 * board moves by more than that between two thousand and twenty, so a
 * reading anybody is going to argue about wants WALK_DRAWS=20000.
 */
const DRAWS = Number(process.env["WALK_DRAWS"] ?? "") || WEEKS;

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
const wire = waiverBar(men, slots, teams, null);

console.log(
  `${league.name}, ${teams} teams, ${pays["rec"] ?? 0} a catch, ` +
  `${DRAWS} weeks drawn`,
);
console.log(
  `lineup ${JSON.stringify(seats.named)} plus ${seats.flex} flex, ` +
  `a typical week ${(opponent.reduce((s, n) => s + n, 0) / opponent.length)
    .toFixed(1)}`,
);
console.log(
  "the wire fills a seat his men cannot with " +
  WHERE.map((w) => `${w} ${(wire[w] ?? 0).toFixed(1)}`).join(", ") + "\n",
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

/**
 * How often his own men could not fill a seat, and what a newcomer has
 * to beat there once the wire has filled the ones they could not.
 */
function openSeats(
  bare: Record<string, { expect: number }[]>,
  wired: Record<string, { expect: number }[]>,
) {
  const out: string[] = [];

  for (const where of WHERE) {
    const its = bare[where] ?? [];
    const empty = its.filter((d) => d.expect === 0).length;
    const bars = wired[where] ?? [];
    const mean = bars.length
      ? bars.reduce((s, d) => s + d.expect, 0) / bars.length
      : 0;
    out.push(`${where} unfilled ${pct(empty / Math.max(1, its.length))} ` +
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
  const passed = baselineFor(assumed, slots, DRAWS, wire);
  // the same baseline with an empty seat left empty, to count them
  const bare = baselineFor(assumed, slots, DRAWS);
  const without = winChance(passed.total, opponent);
  const worth = takeNowFor(had, slots, left, turns, opponent, DRAWS, wire);

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
  console.log("    seats: " + openSeats(bare.displaced, passed.displaced));
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
  const worth = takeNowFor(had, slots, left, turns, opponent, DRAWS, wire);
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
  const assumed = projectedRoster(
    had, slots, left, turnsAll.slice(backupTurn + 1),
  );
  const asIs = winShareFor(baselineFor(assumed, slots, DRAWS), opponent, DRAWS);
  const fair = winShareFor(
    baselineFor(assumed, slots, DRAWS, wire), opponent, DRAWS,
  );
  const wireMan = men.filter((p) => p.position === "QB")
    .sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0))[teams]!;

  console.log(
    `  at p${here.pick.pick_no}, the wire quarterback is ${wireMan.name} ` +
    `at ${(offWaivers(men, "QB", teams, null) ?? 0).toFixed(1)} a game`,
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
  const bar = baselineFor(assumed, slots, DRAWS, wire).displaced["QB"]!;
  const empty = baselineFor(assumed, slots, DRAWS).displaced["QB"]!
    .filter((d) => d.expect === 0).length;
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

/**
 * The first pick taken apart, since a receiver reading nearly double the
 * best back wants explaining.
 *
 * Every variant keeps the man's own key, so he draws the same weeks and
 * misses the same ones and only the thing under test moves. A flat man
 * scores his average every week, which is how much of a reading is his
 * spread rather than his points.
 */
const asFlat = (p: Player): Player => {
  const ppg = p.ppg ?? 0;

  return {
    ...p,
    game: { ev: ppg, q1: ppg, mid: ppg, q3: ppg, low: ppg, high: ppg },
  };
};

const asPosition = (p: Player, position: string): Player => ({ ...p, position });

interface Shown {
  label: string;
  where: string[];
  taken: Player | null;
}

/** every seat the league starts, named ones first and the flex last */
function seatsShown(): Shown[] {
  const { named, flex } = lineupOf(slots);
  const out: Shown[] = [];

  for (const [where, count] of Object.entries(named)) {
    for (let i = 0; i < count; i++) {
      out.push({
        label: count > 1 ? `${where}${i + 1}` : where,
        where: [where],
        taken: null,
      });
    }
  }

  for (let i = 0; i < flex; i++) {
    out.push({ label: "FLEX", where: ["RB", "WR", "TE"], taken: null });
  }

  return out;
}

/**
 * Who ends up in which seat, considered in the order projectedRoster
 * seats them: the men he has already, by value, then the fills in turn
 * order.
 */
function seatedAs(had: Player[], roster: Player[]): Shown[] {
  const seats = seatsShown();
  const order = [
    ...[...had].sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0)),
    ...roster.filter((p) => !had.some((q) => q.key === p.key)),
  ];

  for (const p of order) {
    const seat = seats.find((s) => !s.taken && s.where.includes(p.position));

    if (seat) {
      seat.taken = p;
    }
  }

  return seats;
}

console.log("\n=== pick 1, seat by seat");
const firstTurn = turnsAll.slice(1);
const byName = (name: string) => men.find((p) => p.name === name)!;
const nacua = byName("Puka Nacua");
const gibbs = byName("Jahmyr Gibbs");
const bijan = byName("Bijan Robinson");
const firstWorth = takeNowFor([], slots, men, turnsAll, opponent, DRAWS, wire);

for (const had of [[], [nacua], [gibbs]] as Player[][]) {
  const plan = new Map(
    assumedAt(had, men, firstTurn).map((a) => [a.p.key, a.at]),
  );
  const roster = projectedRoster(had, slots, men, firstTurn);
  const base = baselineFor(roster, slots, DRAWS, wire);
  console.log(
    `  ${had.length ? "taking " + had[0]!.name : "passing over"}, reads ` +
    `${had.length ? at(firstWorth(had[0]!).added) : at(0)}, ` +
    `week ${(base.total.reduce((s, n) => s + n, 0) / base.total.length)
      .toFixed(1)}, win ${winChance(base.total, opponent).toFixed(4)}`,
  );
  console.log("    " + seatedAs(had, roster).map((s) =>
    `${s.label} ${s.taken
      ? `${s.taken.name} ${(s.taken.ppg ?? 0).toFixed(1)}` +
        (plan.has(s.taken.key) ? ` at ${plan.get(s.taken.key)}` : " (his)")
      : "empty"}`).join("; "));

  for (const where of ["RB", "WR"]) {
    const its = base.displaced[where]!.filter((d) => d.expect > 0);
    console.log(
      `    a newcomer at ${where} has to beat ` +
      `${(its.reduce((s, d) => s + d.expect, 0) / Math.max(1, its.length))
        .toFixed(1)} expected and takes the seat off a man who then ` +
      `scored ${(its.reduce((s, d) => s + d.score, 0) / Math.max(1, its.length))
        .toFixed(1)}, in ${pct(its.length / base.total.length)} of weeks`,
    );
  }
}

console.log("\n=== the same two men, one thing changed at a time");
const variants: { of: string; p: Player }[] = [
  { of: "Nacua as he is, WR", p: nacua },
  { of: "Nacua listed at RB", p: asPosition(nacua, "RB") },
  { of: "Nacua flat, WR", p: asFlat(nacua) },
  { of: "Gibbs as he is, RB", p: gibbs },
  { of: "Gibbs listed at WR", p: asPosition(gibbs, "WR") },
  { of: "Gibbs flat, RB", p: asFlat(gibbs) },
  { of: "Robinson as he is, RB", p: bijan },
  { of: "Robinson listed at WR", p: asPosition(bijan, "WR") },
];

for (const { of, p } of variants) {
  const his = firstWorth(p);
  const weeks = weeksOf(p, DRAWS);
  const playing = weeks.filter((w) => w > 0);
  const sorted = [...playing].sort((a, b) => a - b);
  console.log(
    `  ${of.padEnd(22)} ${(p.ppg ?? 0).toFixed(1)} a game, ` +
    `weeks ${sorted[Math.floor(sorted.length * 0.1)]!.toFixed(0)} to ` +
    `${sorted[Math.floor(sorted.length * 0.9)]!.toFixed(0)}, ` +
    `starts ${pct(his.starts)}, added ${at(his.added)}`,
  );
}

console.log("\n=== what the file says about the two of them");

for (const p of [nacua, gibbs, bijan]) {
  console.log(
    `  ${p.name.padEnd(18)} the projection pays ` +
    `${payFor(p.projected ?? {}, pays).toFixed(2)} a game, the walk's own ` +
    `line pays ${payFor(p.simulated ?? {}, pays).toFixed(2)}, and the board ` +
    `uses ${(p.ppg ?? 0).toFixed(1)}`,
  );
}

/**
 * What the fill would hand you at each pick, position by position, under
 * the same availability rule it uses: the first man in board order it
 * still expects to be there. The best points on offer is shown beside
 * him, since board order and points a game are not the same thing.
 */
console.log("\n=== the falloff the fill believes in");
const POSTS = [1, 12, 24, 36, 48, 72, 96, 120];
const stillThere = (p: Player, pick: number) => !p.adp || p.adp >= pick;
const firstFor = (where: string, pick: number) =>
  men.find((p) => p.position === where && stillThere(p, pick));
const bestFor = (where: string, pick: number) =>
  men.filter((p) => p.position === where && stillThere(p, pick))
    .sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0))[0];

console.log("  pick  " + ["QB", "RB", "WR", "TE"]
  .map((w) => (w + " the fill takes / the best left").padEnd(38)).join(""));

for (const pick of POSTS) {
  console.log(
    `  ${String(pick).padStart(4)}  ` +
    ["QB", "RB", "WR", "TE"].map((where) => {
      const him = firstFor(where, pick);
      const best = bestFor(where, pick);

      return `${(him?.name ?? "none").split(" ").slice(-1)[0]} ` +
        `${(him?.ppg ?? 0).toFixed(1)} / ` +
        `${(best?.name ?? "none").split(" ").slice(-1)[0]} ` +
        `${(best?.ppg ?? 0).toFixed(1)}`;
    }).map((s) => s.padEnd(38)).join(""),
  );
}

/**
 * What the fill promised him for his next turn against who was really
 * there when it came. ADP is an average of other rooms, so this is the
 * size of the defect in the one room he was sitting in.
 */
console.log("\n=== what ADP promised for his next turn against what was there");
const slippage: Record<string, number[]> = {};

for (const where of WHERE) {
  slippage[where] = [];
}

for (let turn = 0; turn < mine.length - 1; turn++) {
  const here = mine[turn]!.pick.pick_no;
  const next = mine[turn + 1]!.pick.pick_no;
  const goneNow = new Set(
    took.filter((t) => t.pick.pick_no < here && t.p).map((t) => t.p!.key),
  );
  const goneThen = new Set(
    took.filter((t) => t.pick.pick_no < next && t.p).map((t) => t.p!.key),
  );
  const believedBest = (where: string) => men
    .filter((p) => p.position === where && !goneNow.has(p.key) &&
      stillThere(p, next))
    .reduce((top, p) => Math.max(top, p.ppg ?? 0), 0);
  const actualBest = (where: string) => men
    .filter((p) => p.position === where && !goneThen.has(p.key))
    .reduce((top, p) => Math.max(top, p.ppg ?? 0), 0);
  const gaps = WHERE.map((where) => {
    const gap = believedBest(where) - actualBest(where);
    slippage[where]!.push(gap);

    return `${where} ${believedBest(where).toFixed(1)}/` +
      `${actualBest(where).toFixed(1)}`;
  });
  const penciled = assumedAt(
    mine.slice(0, turn).map((t) => t.p!),
    men.filter((p) => !goneNow.has(p.key)),
    turnsAll.slice(turn + 1),
  ).find((a) => a.at === next);
  console.log(
    `  p${String(here).padStart(3)} for p${String(next).padStart(3)}: ` +
    gaps.join(", ") +
    (penciled
      ? `; penciled ${penciled.p.name} ` +
        `${goneThen.has(penciled.p.key) ? "gone" : "still there"}`
      : ""),
  );
}

for (const where of WHERE) {
  const its = slippage[where]!;
  const mean = its.reduce((s, n) => s + n, 0) / its.length;
  const over = its.filter((n) => n > 0.5).length;
  console.log(
    `  ${where}: ADP was ${mean.toFixed(1)} a game optimistic on average, ` +
    `and over half a point out at ${over} of ${its.length} turns, worst ` +
    `${Math.max(...its).toFixed(1)}`,
  );
}

// men the room took early go back on the board, so one turn can be asked
// about two who never were available together. His own stay off it, since
// a man cannot displace himself.
console.log("\n=== a third round back reading above the first pick");
const loveTurn = 2;
const loveHere = mine[loveTurn]!;
const loveGone = new Set(
  took.filter((t) => t.pick.pick_no < loveHere.pick.pick_no && t.p)
    .map((t) => t.p!.key),
);
const loveHad = mine.slice(0, loveTurn).map((t) => t.p!);
const putBack = [bijan.key, byName("Ja'Marr Chase").key];
const asIfLeft = men.filter((p) =>
  (!loveGone.has(p.key) || putBack.includes(p.key)) &&
  !loveHad.some((q) => q.key === p.key));
const loveTurns = turnsAll.slice(loveTurn);
const loveBase = baselineFor(
  projectedRoster(loveHad, slots, asIfLeft, loveTurns.slice(1)), slots, DRAWS,
  wire,
);
const loveWithout = winChance(loveBase.total, opponent);
const loveWorth = takeNowFor(
  loveHad, slots, asIfLeft, loveTurns, opponent, DRAWS, wire,
);
const earlier = baselineFor(
  projectedRoster(
    mine.slice(0, 1).map((t) => t.p!), slots,
    men.filter((p) => !took.some((t) =>
      t.p && t.p.key === p.key && t.pick.pick_no < 24)),
    turnsAll.slice(2),
  ),
  slots, DRAWS, wire,
);
const earlierWithout = winChance(earlier.total, opponent);

console.log(
  `  the reference at pick 24 read ${earlierWithout.toFixed(4)} and at ` +
  `pick 25 it reads ${loveWithout.toFixed(4)}, a fall of ` +
  `${(earlierWithout - loveWithout).toFixed(4)} from making one pick`,
);

for (const p of [byName("Jeremiyah Love"), bijan, byName("Ja'Marr Chase")]) {
  const his = loveWorth(p);
  console.log(
    `  ${p.name.padEnd(18)} at pick 25 reads ${at(his.added)}, and ` +
    `${at(loveWithout + his.added - earlierWithout)} against the reference ` +
    `one pick earlier`,
  );
}

console.log("\n=== the same turn with more weeks drawn");
const MORE = 20000;
const opponentMore = typicalWeek(men, slots, teams, MORE);
const worthMore = takeNowFor(
  [], slots, men, turnsAll, opponentMore, MORE, wire,
);

for (const p of [nacua, byName("Ja'Marr Chase"), byName("Jaxon Smith-Njigba"),
  gibbs, bijan]) {
  console.log(
    `  ${p.name.padEnd(20)} ${DRAWS} weeks ${at(firstWorth(p).added)}, ` +
    `${MORE} weeks ${at(worthMore(p).added)}`,
  );
}

console.log("\n=== byes");
console.log(
  `  ${men.filter((p) => p.bye).length} of ${men.length} men carry a bye ` +
  `week, and weeksOf reads games and the drawn spread only.`,
);

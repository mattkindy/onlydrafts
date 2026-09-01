/**
 * Whether drafting by wins beats drafting by points, out of sample.
 *
 * Two drafters take the same seat in the same room off the same
 * projection, one ordering by what a man is projected to score and one
 * by what he adds to the weeks you win. Both teams are then scored on
 * what actually happened that season.
 *
 * The projection is last season played forward, which is crude and is
 * the point: both rules get the same crude numbers, so what is
 * measured is the ordering rather than the model.
 *
 * Run: npx tsx scripts/warEval.ts
 */

import { readFileSync } from "node:fs";

import { parseCsv } from "../src/data/csv.js";

const PAIRS = [[2022, 2023], [2023, 2024], [2024, 2025]] as const;

/** the seats a lineup fills, kickers and defences left out */
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX"];
const FLEX = ["RB", "WR", "TE"];
const TEAMS = 12;
const ROUNDS = 10;

const num = (row: Record<string, string>, key: string) =>
  Number(row[key] ?? 0) || 0;

const mean = (its: number[]) =>
  its.length ? its.reduce((s, n) => s + n, 0) / its.length : 0;

/** half a point a catch, which is what the league in question pays */
const scored = (row: Record<string, string>) =>
  num(row, "passing_yards") * 0.04 + num(row, "passing_tds") * 4 -
  num(row, "passing_interceptions") * 2 +
  num(row, "rushing_yards") * 0.1 + num(row, "rushing_tds") * 6 +
  num(row, "receptions") * 0.5 + num(row, "receiving_yards") * 0.1 +
  num(row, "receiving_tds") * 6;

interface Man {
  id: string;
  name: string;
  position: string;
  /** what he did each week of the season being drafted for */
  after: number[];
  /** and of the season before it, which is all anybody knew */
  before: number[];
  adp: number | null;
}

function weeksIn(season: number) {
  const rows = parseCsv(
    readFileSync(`data/raw/stats_player_week_${season}.csv`, "utf8"),
  );
  const by = new Map<string, {
    name: string; position: string; weeks: number[];
  }>();

  for (const row of rows) {
    const week = Number(row["week"]);
    const id = row["player_id"] ?? "";
    const where = row["position"] ?? "";

    if (!id || !week || week > 17 || !["QB", "RB", "WR", "TE"].includes(where)) {
      continue;
    }

    const its = by.get(id) ??
      { name: row["player_display_name"] ?? id, position: where, weeks: [] };
    its.weeks[week - 1] = scored(row);
    by.set(id, its);
  }

  return by;
}

function adpIn(season: number) {
  const said = JSON.parse(
    readFileSync(`data/raw/adp_ppr_${season}.json`, "utf8"),
  ) as { players: { name: string; adp: number }[] };
  const by = new Map<string, number>();

  for (const p of said.players) {
    by.set(p.name.toLowerCase().replace(/[^a-z]/g, ""), p.adp);
  }

  return by;
}

/** the best legal lineup out of whoever played that week */
function lineupOn(roster: Man[], week: number, of: (m: Man) => number[]) {
  const seats = SLOTS.map((s) => (s === "FLEX" ? FLEX : [s]));
  const taken = new Array(seats.length).fill(false) as boolean[];
  const playing = roster
    .map((m) => ({ m, score: of(m)[week] }))
    .filter((x): x is { m: Man; score: number } => typeof x.score === "number")
    .sort((a, b) => b.score - a.score);
  let total = 0;

  for (const { m, score } of playing) {
    const at = seats.findIndex((s, i) => !taken[i] && s.includes(m.position));

    if (at >= 0) {
      taken[at] = true;
      total += score;
    }
  }

  return total;
}

/** what he adds to the weeks you win, on the season anybody had seen */
function warFor(roster: Man[], him: Man, rival: number[]) {
  const withHim = [...roster, him];
  let won = 0;
  let wonWith = 0;

  for (let w = 0; w < 17; w++) {
    const theirs = rival[w] ?? 0;

    if (lineupOn(roster, w, (m) => m.before) > theirs) {
      won++;
    }

    if (lineupOn(withHim, w, (m) => m.before) > theirs) {
      wonWith++;
    }
  }

  return (wonWith - won) / 17;
}

for (const [was, now] of PAIRS) {
  const before = weeksIn(was);
  const after = weeksIn(now);
  const adp = adpIn(now);
  const men: Man[] = [];

  for (const [id, its] of before) {
    const then = after.get(id);
    const played = its.weeks.filter((n) => n !== undefined).length;

    if (!then || played < 6) {
      continue;
    }

    men.push({
      id,
      name: its.name,
      position: its.position,
      after: then.weeks,
      before: its.weeks,
      adp: adp.get(its.name.toLowerCase().replace(/[^a-z]/g, "")) ?? null,
    });
  }

  /** the room drafts on draft position, and anybody unpriced goes last */
  const byAdp = [...men].sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999));
  /**
   * The other drafter goes on value over replacement, which is points
   * over the last man the room starts at his position. Ordering on
   * points alone takes ten quarterbacks, since they score the most, and
   * eight of them cannot start.
   */
  const seasonOf = (m: Man) => m.before.reduce((s, n) => s + (n ?? 0), 0);
  const STARTED: Record<string, number> = { QB: 12, RB: 30, WR: 42, TE: 12 };
  const bar: Record<string, number> = {};

  for (const [where, howMany] of Object.entries(STARTED)) {
    const its = men.filter((m) => m.position === where)
      .map(seasonOf).sort((a, b) => b - a);
    bar[where] = its[Math.min(howMany, its.length - 1)] ?? 0;
  }

  const overBar = (m: Man) => seasonOf(m) - (bar[m.position] ?? 0);
  const byPoints = [...men].sort((a, b) => overBar(b) - overBar(a));
  /** a middling side, for the war measure to aim at and to score against */
  const middling = byAdp.slice(TEAMS * 3, TEAMS * 4 + 8);
  const rival = Array.from({ length: 17 }, (_, w) =>
    lineupOn(middling, w, (m) => m.before));
  const theirs = Array.from({ length: 17 }, (_, w) =>
    lineupOn(middling, w, (m) => m.after));

  /**
   * Which seats a side has left, so a drafter reading the board can at
   * least avoid a sixth back. Once the lineup is full anybody goes.
   */
  const stillOpen = (side: Man[]) => {
    const seats = SLOTS.map((s) => (s === "FLEX" ? FLEX : [s]));
    const taken = new Array(seats.length).fill(false) as boolean[];

    for (const m of side) {
      const at = seats.findIndex((s, i) => !taken[i] && s.includes(m.position));

      if (at >= 0) {
        taken[at] = true;
      }
    }

    const open = new Set<string>();

    seats.forEach((s, i) => {
      if (!taken[i]) {
        s.forEach((where) => open.add(where));
      }
    });

    return open;
  };

  /**
   * The app measures a man against the side you would finish with
   * rather than the handful you have, so that arm is here too. It was
   * added to stop every candidate reading nought on the first pick.
   */
  const fillOut = (side: Man[], left: Man[]) => {
    const filled = [...side];
    const open = stillOpen(side);

    for (const where of open) {
      const him = left.find((m) =>
        m.position === where && !filled.includes(m));

      if (him) {
        filled.push(him);
      }
    }

    return filled;
  };

  const outcome: Record<string, number[]> = {
    points: [], sensible: [], war: [], projected: [],
  };

  for (let seat = 0; seat < TEAMS; seat++) {
    for (const rule of ["points", "sensible", "war", "projected"] as const) {
      const gone = new Set<string>();
      const sides: Man[][] = Array.from({ length: TEAMS }, () => []);

      for (let round = 0; round < ROUNDS; round++) {
        for (let at = 0; at < TEAMS; at++) {
          const turn = round % 2 === 0 ? at : TEAMS - 1 - at;
          const left = byAdp.filter((m) => !gone.has(m.id));

          if (!left.length) {
            continue;
          }

          if (turn !== seat) {
            gone.add(left[0]!.id);
            sides[turn]!.push(left[0]!);
            continue;
          }

          const openNow = stillOpen(sides[seat]!);
          const him = rule === "points"
            ? byPoints.find((m) => !gone.has(m.id))!
            : rule === "sensible"
              ? byPoints.find((m) =>
                !gone.has(m.id) &&
                (openNow.size === 0 || openNow.has(m.position))) ??
                byPoints.find((m) => !gone.has(m.id))!
            : left
              .slice(0, 30)
              .map((m) => ({
                m,
                adds: warFor(
                  rule === "projected"
                    ? fillOut(sides[seat]!, left)
                    : sides[seat]!,
                  m,
                  rival,
                ),
              }))
              .sort((a, b) => b.adds - a.adds)[0]!.m;

          gone.add(him.id);
          sides[seat]!.push(him);
        }
      }

      /**
       * Against the eleven other sides in the same room, week by week,
       * which is the game. A slice of the board used as an opponent
       * picks its best eight out of twenty every week and beats
       * everybody, so both rules read nought against it.
       */
      const weekly = sides.map((side) =>
        Array.from({ length: 17 }, (_, w) => lineupOn(side, w, (m) => m.after)));
      let won = 0;
      let played = 0;

      for (let w = 0; w < 17; w++) {
        for (let other = 0; other < TEAMS; other++) {
          if (other === seat) {
            continue;
          }

          played++;

          if (weekly[seat]![w]! > weekly[other]![w]!) {
            won++;
          }
        }
      }

      outcome[rule]!.push(won / Math.max(1, played));
    }
  }

  const ahead = outcome["war"]!
    .filter((n, i) => n > outcome["sensible"]![i]!).length;

  console.log(
    `${now}  points only ${(mean(outcome["points"]!) * 100).toFixed(1)}%` +
    `   with roster sense ${(mean(outcome["sensible"]!) * 100).toFixed(1)}%` +
    `   by war ${(mean(outcome["war"]!) * 100).toFixed(1)}%` +
    `   war on the projected side ` +
    `${(mean(outcome["projected"]!) * 100).toFixed(1)}%` +
    `   war ahead in ${ahead} of ${TEAMS} seats`,
  );
}

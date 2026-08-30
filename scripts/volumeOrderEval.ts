/**
 * Whose volume is right, the walk's or the projection it starts from?
 *
 * How often a man touches the ball decides most of a back's week, and
 * the number the site shows him comes from the share projection rather
 * than from anything played out. The walk starts from that projection
 * and then moves it, and whether that helps has never been measured.
 *
 * So this asks the walk for its shares on the plays that really
 * happened. The play sequence is then the same for both, and only the
 * allocation is left to be judged.
 *
 * Run: npx tsx scripts/volumeOrderEval.ts [seasons, comma separated]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import {
  experienceBefore, pastShares, projectShares, SHARING_POSITIONS,
} from "../src/features/projectedShares.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { buildWorld } from "../src/features/playedWorld.js";

const SEASONS = (process.argv[2] ?? "2024").split(",").map(Number);
const POSITIONS = ["QB", "RB", "WR", "TE"];
/** 1 is the walk as it is today, and above it the shares pulled apart */
const SHARPENED = [1, 1.1, 1.25, 1.5];

const raw = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
));
const teamPlays = new Map<string, number>();

for (const r of raw) {
  if (["run", "pass"].includes(r["playType"] ?? "")) {
    const key = `${r["season"]}|${r["offense"]}`;
    teamPlays.set(key, (teamPlays.get(key) ?? 0) + 1);
  }
}

for (const season of SEASONS) {
  const before = new Map<string, string>();

  for (const s of await loadPlayerStats(season - 1)) {
    before.set(s.playerId, s.position);
  }

  const world = await buildWorld(season, 1, false, before);
  const plays = raw.filter((r) =>
    Number(r["season"]) === season &&
    ["run", "pass"].includes(r["playType"] ?? ""));

  /** the men each side had, as the walk sees them */
  const among = new Map<string, string[]>();

  for (const team of new Set(plays.map((r) => r["offense"]!))) {
    const side = world.sideFor(team);

    if (side) {
      among.set(team, side.among);
    }
  }

  /**
   * What the walk hands each man over those same plays, and the same
   * again with the shares pulled toward whoever is likeliest before
   * they are normalised. A projection is shrunk toward the middle to
   * be right on average, which leaves the busiest man of a side a
   * little short, and the power says how much of that to undo.
   */
  const walkedAt = new Map<number, Map<string, number>>(
    SHARPENED.map((power) => [power, new Map<string, number>()]),
  );

  for (const r of plays) {
    const men = among.get(r["offense"]!);
    const down = Number(r["down"]);
    const yardline = Number(r["yardline"]);

    if (!men || !Number.isFinite(down) || !Number.isFinite(yardline)) {
      continue;
    }

    const shares = world.factors.goesTo(
      {
        down, yardline, toGo: Number(r["togo"]),
        margin: Number(r["margin"]) || 0,
        secondsLeft: Number(r["seconds"]) || 1800,
      },
      r["playType"] as "run" | "pass",
      men,
      { offence: r["offense"], defence: r["defense"] },
    );

    for (const [power, into] of walkedAt) {
      let all = 0;

      for (const share of shares.values()) {
        all += share ** power;
      }

      if (all <= 0) {
        continue;
      }

      for (const [player, share] of shares) {
        into.set(player, (into.get(player) ?? 0) + (share ** power) / all);
      }
    }
  }

  const walked = walkedAt.get(1)!;

  /**
   * The projection the walk started from, turned into touches the way
   * the site turns it into touches: his share of his side's work times
   * the plays his side ran last season.
   */
  const week1 = (await loadWeeklyRosters(season)).filter((row) => row.week === 1);
  const roster = week1
    .map((row) => ({
      playerId: row.playerId, position: row.rawPosition, team: row.teamId,
    }))
    .filter((man) => SHARING_POSITIONS.includes(man.position));
  const projected = projectShares({
    season, roster,
    past: await pastShares(
      [season - 3, season - 2, season - 1],
      (s, team) => teamPlays.get(`${s}|${team}`) ?? 1000,
    ),
    picks: await loadDraftPicks(),
    experience: await experienceBefore(season),
  });
  const said = new Map<string, number>();

  for (const man of roster) {
    const share = projected.get(man.playerId);

    if (share !== undefined) {
      said.set(
        man.playerId,
        share * (teamPlays.get(`${season - 1}|${man.team}`) ?? 1000),
      );
    }
  }

  const took = new Map<string, number>();
  const positionOf = new Map<string, string>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18) {
      continue;
    }

    took.set(
      s.playerId,
      (took.get(s.playerId) ?? 0) + (s.carries ?? 0) + (s.targets ?? 0),
    );
    positionOf.set(s.playerId, s.position);
  }

  console.log(`\n${season}, how each orders the touches men went on to take:`);

  for (const where of [null, ...POSITIONS]) {
    // both have to have an opinion, or the walk wins the pooled row on
    // quarterbacks alone, where the projection says nothing and every
    // one of them ties at nothing
    const men = [...took.keys()].filter((id) =>
      walked.has(id) && said.has(id) &&
      (where === null || positionOf.get(id) === where));

    if (men.length < 20) {
      continue;
    }

    const was = men.map((id) => took.get(id) ?? 0);
    console.log(
      `  ${(where ?? "everyone").padEnd(9)}${String(men.length).padStart(5)} men  ` +
      `walk ${spearman(men.map((id) => walked.get(id) ?? 0), was).toFixed(3)}  ` +
      `projection ${spearman(men.map((id) => said.get(id) ?? 0), was).toFixed(3)}`,
    );
  }

  // How lumpy each side's work is, which ordering does not tell you.
  // An allocation can rank men right and still spread the ball too
  // evenly between them.
  const lumps = new Map<string, { top: number; three: number }>();
  let sides = 0;

  for (const [, men] of among) {
    const each: [string, Map<string, number>][] = [
      ["the walk", walked], ["the projection", said], ["really", took],
    ];
    const sorted = each.map(([how, of]) => {
      const mine = men.map((id) => of.get(id) ?? 0).sort((a, b) => b - a);

      return { how, mine, all: mine.reduce((a, b) => a + b, 0) };
    });

    if (sorted.some((s) => s.all <= 0)) {
      continue;
    }

    sides++;

    for (const { how, mine, all } of sorted) {
      const own = lumps.get(how) ?? { top: 0, three: 0 };
      own.top += mine[0]! / all;
      own.three += mine.slice(0, 3).reduce((a, b) => a + b, 0) / all;
      lumps.set(how, own);
    }
  }

  const per = (n: number) => (100 * n / Math.max(1, sides)).toFixed(1);
  console.log(`  and how lumpy it is, over ${sides} sides:`);

  for (const [how, own] of lumps) {
    console.log(
      `    ${how.padEnd(15)}busiest man ${per(own.top)}%  ` +
      `busiest three ${per(own.three)}%`,
    );
  }

  /**
   * The busiest man of a season is picked knowing how it went, so some
   * of the gap above is hindsight rather than flatness. This asks the
   * question without it: the man the walk itself puts first, and what
   * he went on to take.
   */
  console.log("  the man each power puts first, and what he took:");

  for (const [power, of] of walkedAt) {
    let gives = 0;
    let was = 0;
    let sawTop = 0;
    const ordered = [...took.keys()].filter((id) => of.has(id) && said.has(id));

    for (const [, men] of among) {
      const all = men.reduce((sum, id) => sum + (took.get(id) ?? 0), 0);
      const mine = men.reduce((sum, id) => sum + (of.get(id) ?? 0), 0);

      if (all <= 0 || mine <= 0) {
        continue;
      }

      const first = men.reduce((best, id) =>
        (of.get(id) ?? 0) > (of.get(best) ?? 0) ? id : best);
      sawTop++;
      gives += (of.get(first) ?? 0) / mine;
      was += (took.get(first) ?? 0) / all;
    }

    console.log(
      `    power ${power.toFixed(2)}  gives him ` +
      `${(100 * gives / Math.max(1, sawTop)).toFixed(1)}%, he took ` +
      `${(100 * was / Math.max(1, sawTop)).toFixed(1)}%  ` +
      `and it orders everyone ${spearman(
        ordered.map((id) => of.get(id) ?? 0),
        ordered.map((id) => took.get(id) ?? 0),
      ).toFixed(3)}`,
    );
  }
}

/**
 * What you can know about a week in August.
 *
 * A kicker's week is mostly the ground and the weather, and the
 * schedule tells you both. This asks whether a roof, a short week or a
 * night kickoff moves what anybody else scores by enough to show.
 *
 * Fitted on early seasons and checked on later ones, because the last
 * thing measured this way looked good and did not survive the check.
 *
 * Run: npx tsx scripts/knowableWeekEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints } from "../src/scoring/fantasyPoints.js";
import { scoring } from "../src/scoring/active.js";
import { parseCsv } from "../src/data/csv.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const POSITIONS = ["QB", "RB", "WR", "TE"];
const FIT_ON = [2016, 2017, 2018, 2019, 2020];
const CHECK_ON = [2021, 2022, 2023, 2024, 2025];

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));

interface Where {
  roof: string;
  hour: number;
  rest: number;
}

const setting = new Map<string, Where>();

for (const r of rows) {
  if (r["game_type"] !== "REG") {
    continue;
  }

  const roof = r["roof"] ?? "";
  const hour = Number((r["gametime"] ?? "").split(":")[0]);

  setting.set(`${r["season"]}|${r["week"]}|${r["home_team"]}`,
    { roof, hour, rest: Number(r["home_rest"]) });
  setting.set(`${r["season"]}|${r["week"]}|${r["away_team"]}`,
    { roof, hour, rest: Number(r["away_rest"]) });
}

interface Play {
  position: string;
  points: number;
  /** what he averages that season, so a good player does not read as a good roof */
  average: number;
  indoors: boolean;
  shortWeek: boolean;
  night: boolean;
}

async function playsIn(seasons: number[]): Promise<Play[]> {
  const out: Play[] = [];

  for (const season of seasons) {
    const stats = await loadPlayerStats(season);
    const mine = stats.filter((r) => POSITIONS.includes(r.position) && r.week <= 18);
    const total = new Map<string, { points: number; games: number }>();
    const scored = new Map<string, number>();

    for (const r of mine) {
      const points = fantasyPoints(r.statLine, scoring());
      scored.set(`${r.playerId}|${r.week}`, points);
      const so = total.get(r.playerId) ?? { points: 0, games: 0 };
      total.set(r.playerId, { points: so.points + points, games: so.games + 1 });
    }

    for (const r of mine) {
      const his = total.get(r.playerId)!;
      const average = his.points / his.games;
      const where = setting.get(`${season}|${r.week}|${r.teamId}`);

      // a man needs a season behind him before his average means anything
      if (his.games < 8 || average < 4 || !where) {
        continue;
      }

      out.push({
        position: r.position,
        points: scored.get(`${r.playerId}|${r.week}`)!,
        average,
        indoors: where.roof === "dome" || where.roof === "closed",
        shortWeek: Number.isFinite(where.rest) && where.rest <= 4,
        night: Number.isFinite(where.hour) && where.hour >= 18,
      });
    }
  }

  return out;
}

/** how much better or worse than his own average, as a ratio */
const liftOf = (plays: Play[], pick: (p: Play) => boolean) => {
  const yes = plays.filter(pick);
  const no = plays.filter((p) => !pick(p));
  const ratio = (list: Play[]) =>
    list.reduce((s, p) => s + p.points / p.average, 0) / Math.max(1, list.length);

  return { lift: ratio(yes) / ratio(no), n: yes.length };
};

const fit = await playsIn(FIT_ON);
const check = await playsIn(CHECK_ON);

const asks: [string, (p: Play) => boolean][] = [
  ["under a roof", (p) => p.indoors],
  ["on a short week", (p) => p.shortWeek],
  ["at night", (p) => p.night],
];

console.log("A week as a multiple of what he averages. 1.000 means it does nothing.");
console.log(`Fitted on ${FIT_ON[0]}-${FIT_ON.at(-1)}, checked on ${CHECK_ON[0]}-${CHECK_ON.at(-1)}.\n`);
console.log("                          fitted   checked   worth showing");

for (const [name, pick] of asks) {
  for (const position of POSITIONS) {
    const a = liftOf(fit.filter((p) => p.position === position), pick);
    const b = liftOf(check.filter((p) => p.position === position), pick);
    const sameWay = (a.lift - 1) * (b.lift - 1) > 0;
    const worth = sameWay && Math.abs(b.lift - 1) > 0.02;

    console.log(
      `  ${position.padEnd(4)} ${name.padEnd(18)} ${a.lift.toFixed(3)}    ` +
      `${b.lift.toFixed(3)}    ${worth ? "yes" : sameWay ? "same way, too small" : "no"}`,
    );
  }

  console.log("");
}

console.log("Refitted on every season, for the ones that survived the check:\n");

const all = [...fit, ...check];

for (const [name, pick] of asks) {
  for (const position of POSITIONS) {
    const a = liftOf(fit.filter((p) => p.position === position), pick);
    const b = liftOf(check.filter((p) => p.position === position), pick);

    if (!((a.lift - 1) * (b.lift - 1) > 0 && Math.abs(b.lift - 1) > 0.02)) {
      continue;
    }

    const whole = liftOf(all.filter((p) => p.position === position), pick);
    console.log(`  ${position.padEnd(4)} ${name.padEnd(18)} ${whole.lift.toFixed(4)}   (${whole.n} weeks)`);
  }
}

/**
 * The published depth chart against the one the model works out.
 *
 * The share model ranks a team's men by what they did last season and
 * gives each the share a man in that spot usually takes. The league
 * publishes where each man actually stands, and does it before the
 * season starts, so it is there on draft day and sees nothing that has
 * not happened yet.
 *
 * Run: npx tsx scripts/publishedDepthEval.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadDepthChart } from "../src/data/depthCharts.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { divideAmong } from "../src/features/shareCompetition.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;

const SCORE_ON = Number(process.env["SEASON"] ?? 2025);
const POSITIONS = ["RB", "WR", "TE"];

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Year {
  playerId: string;
  position: string;
  team: string;
  touches: number;
  share: number;
}

async function seasonOf(season: number): Promise<Map<string, Year>> {
  const plays = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== season) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    plays.set(row["offense"] ?? "", (plays.get(row["offense"] ?? "") ?? 0) + 1);
  }

  const tally = new Map<string, Year>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !POSITIONS.includes(s.position)) continue;
    const own = tally.get(s.playerId) ?? {
      playerId: s.playerId, position: s.position, team: s.teamId,
      touches: 0, share: 0,
    };
    own.touches += s.carries + s.targets;
    own.team = s.teamId;
    tally.set(s.playerId, own);
  }

  for (const own of tally.values()) {
    own.share = own.touches / (plays.get(own.team) ?? 1000);
  }

  return tally;
}

/** where each man was listed before the season began */
async function publishedRanks(season: number) {
  const chart = await loadDepthChart(season);
  const rank = new Map<string, number>();

  for (const [playerId, spot] of chart) {
    if (POSITIONS.includes(spot.position)) {
      rank.set(playerId, spot.rank);
    }
  }

  return { rank, on: `${season} preseason` };
}

async function main(): Promise<void> {
  const before = await seasonOf(SCORE_ON - 1);
  const now = await seasonOf(SCORE_ON);
  const picks = await loadDraftPicks();
  const { rank: published, on } = await publishedRanks(SCORE_ON);

  console.log(
    `${SCORE_ON}: the last chart before kickoff is ${on}, ` +
      `${published.size} men on it\n`,
  );

  // what a man in each spot takes, and what a rookie's round brings,
  // both measured on the season before
  const byRank = new Map<string, number[]>();
  const teamsBefore = new Map<string, Year[]>();

  for (const man of before.values()) {
    teamsBefore.set(man.team, [...(teamsBefore.get(man.team) ?? []), man]);
  }

  for (const roster of teamsBefore.values()) {
    for (const position of POSITIONS) {
      const group = roster.filter((m) => m.position === position)
        .sort((a, b) => b.share - a.share);
      group.forEach((man, place) => {
        const key = `${position}|${Math.min(place, 5)}`;
        byRank.set(key, [...(byRank.get(key) ?? []), man.share]);
      });
    }
  }

  const usualFor = (position: string, place: number) =>
    middle(byRank.get(`${position}|${Math.min(place, 5)}`) ?? [0.02]);

  const asRookie = new Map<string, number[]>();

  for (const season of [SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1]) {
    for (const man of (await seasonOf(season)).values()) {
      const pick = picks.get(man.playerId);
      if (!pick || pick.season !== season) continue;
      const key = `${man.position}|${Math.min(pick.round, 5)}`;
      asRookie.set(key, [...(asRookie.get(key) ?? []), man.share]);
    }
  }

  const rookieShare = (position: string, round: number) => {
    for (const step of [0, -1, 1, -2, 2, -3, 3]) {
      const at = Math.min(5, Math.max(1, round + step));
      const seen = asRookie.get(`${position}|${at}`) ?? [];
      if (seen.length >= 4) return middle(seen);
    }
    return 0.02;
  };

  const standingOf = (man: Year) => {
    const was = before.get(man.playerId);
    if (was) return was.share;
    const pick = picks.get(man.playerId);
    return pick ? rookieShare(man.position, pick.round) : 0;
  };

  const groupTotal = new Map<string, number>();

  for (const position of POSITIONS) {
    const totals = [...teamsBefore.values()].map((roster) =>
      roster.filter((m) => m.position === position).reduce((a, m) => a + m.share, 0));
    groupTotal.set(position, middle(totals));
  }

  const teamsNow = new Map<string, Year[]>();

  for (const man of now.values()) {
    teamsNow.set(man.team, [...(teamsNow.get(man.team) ?? []), man]);
  }

  const rows: {
    man: Year; worked: number; listed: number; both: number; onChart: boolean;
  }[] = [];

  for (const [, roster] of teamsNow) {
    for (const position of POSITIONS) {
      const group = roster.filter((m) => m.position === position);

      if (!group.length) {
        continue;
      }

      const total = groupTotal.get(position) ?? 0.2;
      const worked = divideAmong(
        group.map((man) => ({ playerId: man.playerId, standing: standingOf(man) })),
        total,
      );
      // the league's own answer to the same question
      const listedStanding = group.map((man) => ({
        playerId: man.playerId,
        standing: usualFor(position, (published.get(man.playerId) ?? 6) - 1),
      }));
      const listed = divideAmong(listedStanding, total);
      const both = divideAmong(
        group.map((man) => ({
          playerId: man.playerId,
          standing: Math.sqrt(
            Math.max(1e-6, (worked.get(man.playerId) ?? 0)) *
            Math.max(1e-6, (listed.get(man.playerId) ?? 0)),
          ),
        })),
        total,
      );

      for (const man of group) {
        rows.push({
          man,
          worked: worked.get(man.playerId) ?? 0,
          listed: listed.get(man.playerId) ?? 0,
          both: both.get(man.playerId) ?? 0,
          onChart: published.has(man.playerId),
        });
      }
    }
  }

  const truth = rows.map((r) => r.man.share);
  console.log("guessing his share of the plays   spearman");

  for (const [label, of] of [
    ["worked out from last season", (r: (typeof rows)[number]) => r.worked],
    ["the published depth chart", (r: (typeof rows)[number]) => r.listed],
    ["the two together", (r: (typeof rows)[number]) => r.both],
  ] as [string, (r: (typeof rows)[number]) => number][]) {
    console.log(
      "  " + label.padEnd(32) + spearman(rows.map(of), truth).toFixed(4).padStart(7),
    );
  }

  // and the question a draft asks: against the room, on the men it
  // priced, mixed as places
  const adp = await loadAdp(SCORE_ON, "ppr").catch(() => new Map());
  const names = new Map<string, string>();
  const scored = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18) continue;
    names.set(s.playerId, s.playerName);
    scored.set(
      s.playerId, (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const plays = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    plays.set(row["offense"] ?? "", (plays.get(row["offense"] ?? "") ?? 0) + 1);
  }

  const priced = rows.map((r) => ({
    row: r,
    adp: adp.get(
      `${normalizeName(names.get(r.man.playerId) ?? "")}|${r.man.position}`,
    )?.adp ?? null,
    points: scored.get(r.man.playerId) ?? 0,
  })).filter((p) => p.adp !== null);

  const place = (values: number[]) => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const out = new Array<number>(values.length);
    order.forEach((o, at) => { out[o.i] = at + 1; });
    return out;
  };

  const pricedTruth = priced.map((p) => p.points);
  const roomPlace = place(priced.map((p) => -p.adp!));
  const modelPlace = place(priced.map((p) =>
    p.row.both * (plays.get(p.row.man.team) ?? 1000)));

  console.log(`\nagainst the room, ${priced.length} men it priced   spearman`);
  console.log(
    "  the model with the chart      " +
    spearman(modelPlace.map((r) => -r), pricedTruth).toFixed(4).padStart(7),
  );
  console.log(
    "  where the room drafted him    " +
    spearman(roomPlace.map((r) => -r), pricedTruth).toFixed(4).padStart(7),
  );
  console.log("\n  leaning on the model by   together");

  for (const lean of [0.2, 0.25, 0.3, 0.4, 0.5]) {
    const mixed = modelPlace.map((m, i) => -(lean * m + (1 - lean) * roomPlace[i]!));
    console.log(
      `    ${(100 * lean).toFixed(0)}%`.padEnd(28) +
      spearman(mixed, pricedTruth).toFixed(4),
    );
  }

  const onIt = rows.filter((r) => r.onChart);
  console.log(
    `\n  ${onIt.length} of ${rows.length} men were on the chart before kickoff`,
  );

  for (const [label, of] of [
    ["worked out from last season", (r: (typeof rows)[number]) => r.worked],
    ["the published depth chart", (r: (typeof rows)[number]) => r.listed],
    ["the two together", (r: (typeof rows)[number]) => r.both],
  ] as [string, (r: (typeof rows)[number]) => number][]) {
    console.log(
      "  " + label.padEnd(32) +
      spearman(onIt.map(of), onIt.map((r) => r.man.share)).toFixed(4).padStart(7),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

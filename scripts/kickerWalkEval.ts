/**
 * Does giving a kicker the kicks his side gets beat where he is drafted?
 * Run: npx tsx scripts/kickerWalkEval.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadSleeperAdp } from "../src/data/adp.js";
import { loadWeeklyRosters } from "../src/data/nflverse.js";
import { normalizeName } from "../src/data/names.js";
import { kickerParts, BANDS } from "../src/features/kickerFromWalk.js";

const RAW = join(import.meta.dirname, "..", "data", "raw");
const SEASON = Number(process.env["SEASON"] ?? 2025);

const num = (r: Record<string, string | undefined>, k: string) =>
  Number(r[k] ?? 0) || 0;

const scored = (parts: Record<string, number>) =>
  (parts["fgmYds"] ?? 0) * 0.1 + (parts["xpm"] ?? 0) -
  3 * (parts["fgmiss_0_19"] ?? 0) - 2 * (parts["fgmiss_20_29"] ?? 0) -
  2 * (parts["fgmiss_30_39"] ?? 0) - (parts["fgmiss_40_49"] ?? 0) -
  (parts["fgmiss_50_59"] ?? 0) - (parts["xpmiss"] ?? 0);

async function tally(season: number) {
  const out = new Map<string, {
    name: string; team: string; games: number; parts: Record<string, number>;
  }>();

  for (const r of parseCsv(await readFile(
    join(RAW, `stats_player_week_${season}.csv`), "utf8",
  ))) {
    if (r["position"] !== "K" || Number(r["week"]) > 18) continue;
    const id = r["player_id"] ?? "";
    const his = out.get(id) ?? {
      name: r["player_display_name"] ?? id, team: r["team"] ?? "",
      games: 0, parts: {} as Record<string, number>,
    };
    his.games++;
    his.team = r["team"] ?? his.team;
    const add = (p: string, n: number) => { his.parts[p] = (his.parts[p] ?? 0) + n; };
    add("fgmYds", num(r, "fg_made_distance"));
    add("xpm", num(r, "pat_made"));
    add("xpmiss", num(r, "pat_missed"));
    for (const band of ["0_19", "20_29", "30_39", "40_49", "50_59"]) {
      add(`fgm_${band}`, num(r, `fg_made_${band}`));
      add(`fgmiss_${band}`, num(r, `fg_missed_${band}`));
    }
    add("fgm_60p", num(r, "fg_made_60_"));
    add("fgmiss_60p", num(r, "fg_missed_60_"));
    out.set(id, his);
  }

  return out;
}

async function main(): Promise<void> {
  const was = await tally(SEASON - 1);
  const is = await tally(SEASON);
  const walk = JSON.parse(await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${SEASON}.json`), "utf8",
  )) as { kicks?: [string, { from: number[]; conversions: number }][] };
  const kicks = new Map(walk.kicks ?? []);
  const adp = await loadSleeperAdp(SEASON, "standard").catch(() => new Map());
  const nowOn = new Map<string, string>();

  for (const r of await loadWeeklyRosters(SEASON).catch(() => [])) {
    if (!nowOn.has(r.playerId)) nowOn.set(r.playerId, r.teamId);
  }

  const rows: { name: string; walk: number; last: number; adp: number; truth: number }[] = [];

  for (const [id, his] of was) {
    const now = is.get(id);
    if (!now || his.games < 6 || now.games < 6) continue;
    const team = nowOn.get(id) ?? his.team;
    const its = kicks.get(team);
    if (!its) continue;
    const said = kickerParts(
      {
        attempts: 0, made: 0,
        byBand: BANDS.map((b) => ({
          attempts: (his.parts[`fgm_${b.name}`] ?? 0) + (his.parts[`fgmiss_${b.name}`] ?? 0),
          made: his.parts[`fgm_${b.name}`] ?? 0,
        })),
        extraPointRate: (his.parts["xpm"] ?? 0) > 0
          ? (his.parts["xpm"] ?? 0) / Math.max(1, (his.parts["xpm"] ?? 0) + (his.parts["xpmiss"] ?? 0))
          : 0.96,
      },
      its.from.map((y) => y + 17),
      its.conversions * 40,
      17 * 40,
    );
    rows.push({
      name: his.name,
      walk: scored(said),
      last: scored(his.parts) / his.games,
      adp: adp.get(`${normalizeName(his.name)}|K`)?.adp ?? 250,
      truth: scored(now.parts) / now.games,
    });
  }

  const truth = rows.map((r) => r.truth);
  console.log(`ordering ${SEASON} kickers, ${rows.length} of them`);
  console.log(`  where the room drafted them   ${spearman(rows.map((r) => -r.adp), truth).toFixed(3)}`);
  console.log(`  what he kicked last season    ${spearman(rows.map((r) => r.last), truth).toFixed(3)}`);
  console.log(`  the kicks the walk gives him  ${spearman(rows.map((r) => r.walk), truth).toFixed(3)}`);
}

await main();

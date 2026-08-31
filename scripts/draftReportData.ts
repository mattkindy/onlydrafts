/**
 * Everything a draft report needs, as one blob of JSON.
 *
 * Run: npx tsx scripts/draftReportData.ts <sleeper name> [league] > out.json
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rescore } from "../app/lib/board.js";
import { normalizeName } from "../app/lib/store.js";
import type { Pays, Player } from "../app/lib/scoring.js";
import {
  gradesFor, keyForPick, marketCurve, ratePicks, rateTeams, worthOf,
} from "../app/lib/draftRating.js";

const WHO = process.argv[2] ?? "mattkindy";
const WANTED = process.argv[3] ?? "";
const get = async <T>(at: string): Promise<T> =>
  fetch(`https://api.sleeper.app/v1${at}`).then((r) => r.json() as Promise<T>);

const user = await get<{ user_id: string }>(`/user/${WHO}`);
const leagues = await get<{
  league_id: string; name: string; status: string; draft_id: string;
  total_rosters: number; roster_positions: string[];
  scoring_settings: Record<string, number>;
}[]>(`/user/${user.user_id}/leagues/nfl/2026`);
const league = leagues.find((l) =>
  (WANTED ? l.name.toLowerCase().includes(WANTED.toLowerCase()) : true) &&
  l.status !== "pre_draft")!;

/**
 * Who cannot play, asked of the provider rather than of the play files.
 *
 * The weekly roster files are the natural place to look and they are the
 * wrong place: the 2026 one is a week one snapshot taken in August, its
 * exempt code E14 is the international pathway rather than the
 * commissioner's list, and a man added to that list today is nowhere in
 * it. Sleeper carries the same fact as an injury status of DNR.
 */
/**
 * How much of a man is left, by why he is not playing. None of these
 * is nothing: a list can end, a knee can mend, and a man on the physically
 * unable list misses four games of seventeen rather than the year.
 */
const STILL_WORTH: Record<string, number> = {
  DNR: 0.15, Sus: 0.15, IR: 0.1, NFI: 0.25, PUP: 0.6, COV: 0.9,
  Out: 0.9, Doubtful: 0.9,
  Inactive: 0.1, "Injured Reserve": 0.1,
  "Physically Unable to Perform": 0.6, "Non Football Injury": 0.25,
};

const everyone = await get<Record<string, {
  status?: string | null; injury_status?: string | null;
}>>("/players/nfl");
/** what is left of him, and why, with one meaning he is fine */
const leftOf = (playerId: string): { keeps: number; why: string } => {
  const man = everyone[playerId];
  const hurt = man?.injury_status ?? "";
  const how = man?.status ?? "";

  if (STILL_WORTH[hurt] !== undefined) {
    return { keeps: STILL_WORTH[hurt]!, why: hurt };
  }

  if (STILL_WORTH[how] !== undefined) {
    return { keeps: STILL_WORTH[how]!, why: how };
  }

  return { keeps: 1, why: "" };
};

const [picks, members] = await Promise.all([
  get<{
    pick_no: number; picked_by: string; is_keeper: boolean | null;
    draft_slot: number;
    metadata: {
      first_name: string; last_name: string; position: string; team: string;
      player_id: string;
    };
  }[]>(`/draft/${league.draft_id}/picks`),
  get<{ user_id: string; display_name: string }[]>(
    `/league/${league.league_id}/users`),
]);

const named = new Map(members.map((m) => [m.user_id, m.display_name]));
const file = JSON.parse(await readFile(
  join(import.meta.dirname, "..", "docs", "data", "board-2026.json"), "utf8",
)) as { players: Player[] };
const board = rescore(file.players, {
  teams: league.total_rosters,
  slots: league.roster_positions,
  pays: league.scoring_settings as unknown as Pays,
});
const byKey = new Map(board.map((p) => [p.key, p]));
const curve = marketCurve(board);
const asPick = (pick: typeof picks[number]) => ({
  name: `${pick.metadata.first_name} ${pick.metadata.last_name}`,
  position: pick.metadata.position,
  team: pick.metadata.team,
});

const took = new Map<string, { at: number; p: Player }[]>();
const out = new Map<string, { keeps: number; why: string }>();
const kept = new Map<string, string[]>();
const slotOf = new Map<string, number>();

for (const pick of picks) {
  const who = named.get(pick.picked_by) ?? pick.picked_by;

  if (!slotOf.has(who)) {
    slotOf.set(who, pick.draft_slot);
  }

  if (pick.is_keeper) {
    kept.set(who, [...(kept.get(who) ?? []), asPick(pick).name]);
    continue;
  }

  const p = byKey.get(keyForPick(asPick(pick), normalizeName));

  if (p) {
    took.set(who, [...(took.get(who) ?? []), { at: pick.pick_no, p }]);

    const left = leftOf(pick.metadata.player_id);

    if (left.keeps < 1) {
      out.set(p.key, left);
    }
  }
}

/**
 * The same draft with the men who cannot play worth nothing. The pick
 * they cost still counts, because it was still spent.
 */
const nowRated = rateTeams(
  [...took.entries()].map(([owner, its]) => ({
    owner,
    took: its.map((t) => {
      const left = out.get(t.p.key);

      return left
        ? {
            at: t.at,
            p: {
              ...t.p,
              vor: (t.p.vor ?? 0) * left.keeps,
              adp: t.p.adp === null || t.p.adp === undefined
                ? t.p.adp
                : t.p.adp / Math.max(0.05, left.keeps),
            } as Player,
          }
        : t;
    }),
  })),
  league.roster_positions, curve,
);
const nowGrades = gradesFor(nowRated);

const rated = rateTeams(
  [...took.entries()].map(([owner, its]) => ({ owner, took: its })),
  league.roster_positions, curve,
);
const grades = gradesFor(rated);

console.log(JSON.stringify({
  league: {
    name: league.name, teams: league.total_rosters,
    slots: league.roster_positions,
    perCatch: league.scoring_settings["rec"] ?? 0,
    picks: picks.length, keepers: picks.filter((p) => p.is_keeper).length,
  },
  teams: rated.map((t) => ({
    owner: t.owner,
    grade: grades.get(t.owner) ?? "C",
    over: Number(t.over.toFixed(1)),
    got: Number(t.got.toFixed(1)),
    expected: Number(t.expected.toFixed(1)),
    slot: slotOf.get(t.owner) ?? null,
    kept: kept.get(t.owner) ?? [],
    starters: t.starters.map((s) => ({
      slot: s.slot, name: s.p.name, position: s.p.position,
      adp: s.p.adp ?? null, vor: s.p.vor ?? 0,
    })),
    bench: t.bench.map((p) => ({
      name: p.name, position: p.position, adp: p.adp ?? null,
    })),
    nowOver: Number((nowRated.find((n) => n.owner === t.owner)?.over ?? 0)
      .toFixed(1)),
    nowGrade: nowGrades.get(t.owner) ?? "C",
    picks: ratePicks(took.get(t.owner) ?? [], curve).map((r) => ({
      at: r.at,
      round: Math.ceil(r.at / league.total_rosters),
      name: r.p.name, position: r.p.position,
      adp: r.adp === null ? null : Number(r.adp.toFixed(0)),
      waited: r.waited === null ? null : Number(r.waited.toFixed(0)),
      over: Number(r.over.toFixed(1)),
      worth: Number(worthOf(r.p, curve).toFixed(1)),
      out: out.get(r.p.key)?.why ?? null,
      keeps: out.get(r.p.key)?.keeps ?? 1,
    })),
  })),
}, null, 1));

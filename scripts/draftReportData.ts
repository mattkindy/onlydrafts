/**
 * Everything a draft report needs, as one blob of JSON.
 *
 * Run: npx tsx scripts/draftReportData.ts <sleeper name> [league] > out.json
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rescore } from "../app/lib/board.js";
import { normalizeName } from "../app/lib/store.js";
import { lineupOf, type Pays, type Player } from "../app/lib/scoring.js";
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

/**
 * What Sleeper thinks everybody scores, so its opinion can be put next
 * to ours. Standard points, since that is what this league pays, over
 * the games it expects each man to play.
 */
const SAYS = "https://api.sleeper.com/projections/nfl/2026" +
  "?season_type=regular&order_by=pts_std" +
  ["QB", "RB", "WR", "TE", "K", "DEF"].map((w) => `&position[]=${w}`).join("");
const theirs = new Map<string, number>();

for (const row of await fetch(SAYS)
  .then((r) => r.json() as Promise<{
    player_id: string; stats: { pts_std?: number; gp?: number };
  }[]>)
  .catch(() => [])) {
  const games = row.stats.gp ?? 0;

  if (games > 0 && row.stats.pts_std) {
    theirs.set(row.player_id, row.stats.pts_std / games);
  }
}

const everyone = await get<Record<string, {
  status?: string | null; injury_status?: string | null;
  injury_body_part?: string | null; injury_notes?: string | null;
  first_name?: string; last_name?: string; position?: string;
  team?: string | null;
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

const [picks, members, rosters] = await Promise.all([
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
  get<{ owner_id: string; players: string[] | null }[]>(
    `/league/${league.league_id}/rosters`),
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
/**
 * Everybody a side actually rosters right now, which is not the same as
 * everybody it drafted. Free agents get taken the minute a draft ends,
 * and one of these teams found its kicker that way.
 */
const rostered = new Map<string, Player[]>();

for (const side of rosters) {
  const who = named.get(side.owner_id) ?? side.owner_id;
  const men: Player[] = [];

  for (const playerId of side.players ?? []) {
    const man = everyone[playerId] as {
      first_name?: string; last_name?: string; position?: string;
      team?: string | null;
    } | undefined;

    if (!man) {
      continue;
    }

    const p = byKey.get(keyForPick({
      name: `${man.first_name ?? ""} ${man.last_name ?? ""}`.trim(),
      position: man.position ?? "",
      team: man.team,
    }, normalizeName));

    if (p) {
      const left = leftOf(playerId);
      const said = (theirs.get(playerId) ?? 0) * left.keeps;
      men.push({
        ...p,
        ppg: (p.ppg ?? 0) * left.keeps,
        perGameVor: (p.perGameVor ?? 0) * left.keeps,
        theirPpg: said,
      } as Player & { theirPpg: number });
    }
  }

  rostered.set(who, men);
}
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

/**
 * What each side will actually put on the field, keepers and all.
 *
 * A different question from the draft grade, which only asks whether
 * you beat your own slots. This asks how good the team is, and a man
 * you kept counts here even though he was never drafted.
 */
const fielded = [...rostered.entries()].map(([owner, men]) => {
  const { named, flex } = lineupOf(league.roster_positions);
  const left = [...men].sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0));
  const starters: { slot: string; p: Player }[] = [];
  const take = (fits: (p: Player) => boolean, slot: string) => {
    const at = left.findIndex(fits);

    if (at >= 0) {
      starters.push({ slot, p: left[at]! });
      left.splice(at, 1);
    }
  };

  for (const [where, count] of Object.entries(named)) {
    for (let i = 0; i < count; i++) {
      take((p) => p.position === where, where);
    }
  }

  for (let i = 0; i < flex; i++) {
    take((p) => ["RB", "WR", "TE"].includes(p.position), "FLEX");
  }

  /**
   * The same lineup chosen again on Sleeper's numbers rather than ours,
   * because the two disagree about who the best nine are and that is
   * the whole point of putting them side by side.
   */
  const asTheySee = (() => {
    const spare = [...men].sort((a, b) =>
      ((b as { theirPpg?: number }).theirPpg ?? 0) -
      ((a as { theirPpg?: number }).theirPpg ?? 0));
    const picked: Player[] = [];
    const grab = (fits: (p: Player) => boolean) => {
      const at = spare.findIndex(fits);

      if (at >= 0) {
        picked.push(spare[at]!);
        spare.splice(at, 1);
      }
    };

    for (const [where, count] of Object.entries(named)) {
      for (let i = 0; i < count; i++) {
        grab((p) => p.position === where);
      }
    }

    for (let i = 0; i < flex; i++) {
      grab((p) => ["RB", "WR", "TE"].includes(p.position));
    }

    return picked.reduce((sum, p) =>
      sum + ((p as { theirPpg?: number }).theirPpg ?? 0), 0);
  })();

  return {
    owner,
    theirs: asTheySee,
    ppg: starters.reduce((sum, s) => sum + (s.p.ppg ?? 0), 0),
    /**
     * The same lineup counted over what a replacement starter at each
     * spot would give you. A 24 point quarterback and a 24 point
     * receiver are not the same asset when the league starts one
     * quarterback and everybody can find one.
     */
    vor: starters.reduce((sum, s) => sum + (s.p.perGameVor ?? 0), 0),
    /** and what is behind them, since byes and injuries happen */
    bench: left.reduce((sum, p) => sum + Math.max(0, p.perGameVor ?? 0), 0),
    starters,
  };
});

/**
 * What the worst starter at each spot is worth, on each set of numbers.
 *
 * Both sides get measured the same way or the two totals cannot sit
 * next to each other: for every slot, take each team's starter there,
 * and the weakest of the twelve is what replacement means. A team's
 * score is how far its nine beat that.
 */
const worstAt = (pick: (p: Player) => number) => {
  const floor = new Map<string, number>();

  for (const where of ["QB", "RB", "WR", "TE", "K", "DEF", "FLEX"]) {
    const its = fielded
      .map((f) => f.starters.filter((s) => s.slot === where)
        .map((s) => pick(s.p)))
      .flat();

    if (its.length) {
      floor.set(where, Math.min(...its));
    }
  }

  return floor;
};

const mineFloor = worstAt((p) => p.ppg ?? 0);
const theirFloor = worstAt(
  (p) => (p as { theirPpg?: number }).theirPpg ?? 0);

const scored = fielded.map((f) => ({
  owner: f.owner,
  ppg: f.ppg,
  starters: f.starters,
  mine: f.starters.reduce((sum, s) =>
    sum + ((s.p.ppg ?? 0) - (mineFloor.get(s.slot) ?? 0)), 0),
  theirs: f.starters.reduce((sum, s) =>
    sum + (((s.p as { theirPpg?: number }).theirPpg ?? 0) -
      (theirFloor.get(s.slot) ?? 0)), 0),
  over: new Map(f.starters.map((s) => [
    s.p.name,
    (s.p.ppg ?? 0) - (mineFloor.get(s.slot) ?? 0),
  ])),
}));

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
    perPick: Number(t.perPick.toFixed(2)),
    made: t.picks,
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
    field: (() => {
      const f = scored.find((x) => x.owner === t.owner);

      return f
        ? {
            ppg: Number(f.ppg.toFixed(1)),
            mine: Number(f.mine.toFixed(1)),
            theirs: Number(f.theirs.toFixed(1)),
            starters: f.starters.map((s) => ({
              slot: s.slot, name: s.p.name, position: s.p.position,
              ppg: Number((s.p.ppg ?? 0).toFixed(1)),
              over: Number((f.over.get(s.p.name) ?? 0).toFixed(1)),
            })),
          }
        : null;
    })(),
    nowPerPick: Number((nowRated.find((n) => n.owner === t.owner)?.perPick ?? 0)
      .toFixed(2)),
    nowGrade: nowGrades.get(t.owner) ?? "C",
    picks: ratePicks(took.get(t.owner) ?? [], curve).map((r) => ({
      at: r.at,
      round: Math.ceil(r.at / league.total_rosters),
      name: r.p.name, position: r.p.position,
      adp: r.adp === null ? null : Number(r.adp.toFixed(0)),
      fell: r.fell === null ? null : Number(r.fell.toFixed(0)),
      over: Number(r.over.toFixed(1)),
      worth: Number(worthOf(r.p, curve).toFixed(1)),
      out: out.get(r.p.key)?.why ?? null,
      keeps: out.get(r.p.key)?.keeps ?? 1,
    })),
  })),
}, null, 1));

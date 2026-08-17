/**
 * Where a share comes from: the man, or his place on the depth chart.
 *
 * Carrying a player's old share to his new team does not help, which
 * makes sense. A share is not something he owns, it is what he wins
 * against whoever else is on the roster. So the other way round: work
 * out where he stands among his team-mates, and give him whatever a man
 * in that spot usually gets.
 *
 * Run: npx tsx scripts/depthShareEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { loadAdp } from "../src/data/adp.js";
import { divideAmong, COMPETITION_DEFAULTS } from "../src/features/shareCompetition.js";
import { normalizeName } from "../src/data/names.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;

const SCORE_ON = Number(process.env["SEASON"] ?? 2025);

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Man {
  playerId: string;
  position: string;
  team: string;
  touches: number;
  games: number;
  share: number;
}

async function seasonOf(season: number): Promise<Man[]> {
  const teamPlays = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== season) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    teamPlays.set(row["offense"] ?? "", (teamPlays.get(row["offense"] ?? "") ?? 0) + 1);
  }

  const tally = new Map<string, Man>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    const own = tally.get(s.playerId) ?? {
      playerId: s.playerId, position: s.position, team: s.teamId,
      touches: 0, games: 0, share: 0,
    };
    own.games++;
    own.team = s.teamId;
    own.touches += s.carries + s.targets;
    tally.set(s.playerId, own);
  }

  for (const man of tally.values()) {
    man.share = man.touches / (teamPlays.get(man.team) ?? 1000);
  }

  return [...tally.values()];
}

// How hard the better man is favoured, chosen on an earlier pair of
// seasons so this one is not asked to pick it and then judge it.
const sharpness = Number(process.env["SHARPNESS"] ?? COMPETITION_DEFAULTS.sharpness);
const quiet = process.env["QUIET"] === "1";

async function main(): Promise<void> {
  const before = await seasonOf(SCORE_ON - 1);
  const now = await seasonOf(SCORE_ON);
  const wasLike = new Map(before.map((man) => [man.playerId, man]));
  const picks = await loadDraftPicks();

  /**
   * What a man drafted in each round actually took in his first season,
   * measured over the seasons before this one, so a rookie can be put
   * somewhere better than the back of the queue.
   */
  const asRookie = new Map<string, number[]>();

  for (const season of [2022, 2023, 2024]) {
    const theirs = await seasonOf(season);
    const played = new Set(theirs.map((m) => m.playerId));
    void played;

    for (const man of theirs) {
      const pick = picks.get(man.playerId);

      if (!pick || pick.season !== season) {
        continue;
      }

      const key = `${man.position}|${Math.min(pick.round, 5)}`;
      asRookie.set(key, [...(asRookie.get(key) ?? []), man.share]);
    }
  }

  /**
   * A round with too few men behind it borrows from the nearest round
   * that has enough, looking earlier first. Falling through to nothing
   * put a first round back at the bottom of his own depth chart, which
   * is the opposite of what his round says.
   */
  const rookieShare = (position: string, round: number) => {
    for (const step of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
      const at = Math.min(5, Math.max(1, round + step));
      const seen = asRookie.get(`${position}|${at}`) ?? [];

      if (seen.length >= 4) {
        return middle(seen);
      }
    }

    return 0.02;
  };

  if (!quiet) {
  console.log("what a rookie takes in his first season, by round");

  for (const position of ["RB", "WR", "TE"]) {
    console.log(
      "  " + position.padEnd(4) +
      [1, 2, 3, 4].map((round) =>
        (100 * rookieShare(position, round)).toFixed(1) + "%").join("  "),
    );
  }

  }
  console.log();

  // what a man in each spot usually gets, measured last season
  const byRank = new Map<string, number[]>();
  const teamsBefore = new Map<string, Man[]>();

  for (const man of before) {
    teamsBefore.set(man.team, [...(teamsBefore.get(man.team) ?? []), man]);
  }

  for (const roster of teamsBefore.values()) {
    for (const position of ["RB", "WR", "TE"]) {
      const group = roster.filter((m) => m.position === position)
        .sort((a, b) => b.share - a.share);

      group.forEach((man, rank) => {
        const key = `${position}|${Math.min(rank, 5)}`;
        byRank.set(key, [...(byRank.get(key) ?? []), man.share]);
      });
    }
  }

  const usualFor = (position: string, rank: number) =>
    middle(byRank.get(`${position}|${Math.min(rank, 5)}`) ?? [0.02]);

  console.log("what a man in each spot takes of his offence's plays");

  for (const position of ["RB", "WR", "TE"]) {
    console.log(
      "  " + position.padEnd(4) +
      [0, 1, 2, 3].map((rank) =>
        (100 * usualFor(position, rank)).toFixed(1) + "%").join("  "),
    );
  }

  // this season's rosters, with each man placed by what he did before
  const teamsNow = new Map<string, Man[]>();

  for (const man of now) {
    teamsNow.set(man.team, [...(teamsNow.get(man.team) ?? []), man]);
  }

  /**
   * What a position group takes of an offence, and what each man has
   * shown, so the group's work can be divided between them.
   */
  const standingOf = (man: Man, position: string) => {
    const was = wasLike.get(man.playerId);

    if (was) {
      return was.share;
    }

    const pick = picks.get(man.playerId);
    return pick ? rookieShare(position, pick.round) : 0;
  };

  const groupTotal = new Map<string, number>();

  for (const roster of teamsBefore.values()) {
    for (const position of ["RB", "WR", "TE"]) {
      const key = position;
      const total = roster.filter((m) => m.position === position)
        .reduce((a, m) => a + m.share, 0);
      groupTotal.set(key, (groupTotal.get(key) ?? 0) + total);
    }
  }

  for (const [key, total] of groupTotal) {
    groupTotal.set(key, total / teamsBefore.size);
  }

  console.log(
    "a position group's share of an offence: " +
    ["RB", "WR", "TE"].map((p) =>
      `${p} ${(100 * (groupTotal.get(p) ?? 0)).toFixed(0)}%`).join(", ") + "\n",
  );

  const rows: {
    man: Man; carried: number; byPlace: number; withDraft: number;
    blended: number; won: number;
  }[] = [];

  for (const roster of teamsNow.values()) {
    for (const position of ["RB", "WR", "TE"]) {
      const group = roster.filter((m) => m.position === position);
      // placed by what he did last season, wherever he did it. A man
      // with no last season goes to the back, which is where a model
      // with nothing on rookies has to put him.
      // where a man stands: what he did last season, or for somebody
      // with no last season, what his draft round usually brings
      const standing = (id: string) => {
        const was = wasLike.get(id);

        if (was) {
          return was.share;
        }

        const pick = picks.get(id);
        return pick ? rookieShare(position, pick.round) : 0;
      };

      const blind = [...group].sort((a, b) =>
        (wasLike.get(b.playerId)?.share ?? 0) - (wasLike.get(a.playerId)?.share ?? 0));
      const placed = [...group].sort((a, b) => standing(b.playerId) - standing(a.playerId));
      const spotOf = new Map(placed.map((man, rank) => [man.playerId, rank]));

      // the group's work divided between whoever is here, by how they
      // compare rather than by the queue they form
      const won = divideAmong(
        group.map((man) => ({
          playerId: man.playerId, standing: standingOf(man, position),
        })),
        groupTotal.get(position) ?? 0.2,
        { ...COMPETITION_DEFAULTS, sharpness },
      );

      blind.forEach((man, rank) => {
        const carried = wasLike.get(man.playerId)?.share ?? 0;
        const slot = usualFor(position, spotOf.get(man.playerId)!);
        rows.push({
          man, carried,
          byPlace: usualFor(position, rank),
          withDraft: slot,
          // his own history where he has one, half weighted against the
          // spot he is now in, since a man who moves behind somebody
          // better does not keep what he used to take
          blended: wasLike.has(man.playerId) ? (carried + slot) / 2 : slot,
          won: won.get(man.playerId) ?? 0,
        });
      });
    }
  }

  const known = rows.filter((r) => wasLike.has(r.man.playerId));
  const fresh = rows.filter((r) => !wasLike.has(r.man.playerId));

  console.log(
    `\n${rows.length} men on a ${SCORE_ON} roster, ${fresh.length} with no season before it`,
  );
  console.log("\nguessing his share of the plays this season   spearman");

  for (const [label, set] of [
    ["everyone", rows], ["only men who played last season", known],
  ] as [string, typeof rows][]) {
    console.log(
      "  " + label.padEnd(36) +
      "\n    carrying his old share    " +
      spearman(set.map((r) => r.carried), set.map((r) => r.man.share)).toFixed(4) +
      "\n    by his place on the depth chart      " +
      spearman(set.map((r) => r.byPlace), set.map((r) => r.man.share)).toFixed(4) +
      "\n    with rookies placed by their round   " +
      spearman(set.map((r) => r.withDraft), set.map((r) => r.man.share)).toFixed(4) +
      "\n    his own history and his spot, halved  " +
      spearman(set.map((r) => r.blended), set.map((r) => r.man.share)).toFixed(4) +
      "\n    won against who he plays with        " +
      spearman(set.map((r) => r.won), set.map((r) => r.man.share)).toFixed(4),
    );
  }

  // and what that does to the thing a draft board is ranking
  const playsNow = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    playsNow.set(row["offense"] ?? "", (playsNow.get(row["offense"] ?? "") ?? 0) + 1);
  }

  const scored = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18) continue;
    scored.set(
      s.playerId,
      (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const forBoard = rows.filter((r) => scored.has(r.man.playerId));
  const truth = forBoard.map((r) => scored.get(r.man.playerId)!);
  // a share turned into a season of points, at one rate for everybody,
  // since per player efficiency was worth about a hundredth
  const asPoints = (share: number, team: string) =>
    share * (playsNow.get(team) ?? 1000);

  // the room's own answer, on the men it had a price for, so the two
  // are judged on the same players
  const adp = await loadAdp(SCORE_ON, "ppr").catch(() => new Map());
  const names = new Map<string, string>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    names.set(s.playerId, s.playerName);
  }

  const priced = forBoard.map((r) => ({
    row: r,
    adp: adp.get(
      `${normalizeName(names.get(r.man.playerId) ?? "")}|${r.man.position}`,
    )?.adp ?? null,
  }));
  const withPrice = priced.filter((p) => p.adp !== null);

  const ways: [string, (r: (typeof rows)[number]) => number][] = [
    ["carrying his old share", (r) => asPoints(r.carried, r.man.team)],
    ["his own history and his spot", (r) => asPoints(r.blended, r.man.team)],
    ["won against who he plays with", (r) => asPoints(r.won, r.man.team)],
  ];

  console.log(`\nranking a season of points, ${forBoard.length} men   spearman`);

  for (const [label, of] of ways) {
    console.log(
      "  " + label.padEnd(32) +
      spearman(forBoard.map(of), truth).toFixed(4).padStart(7),
    );
  }

  const pricedTruth = withPrice.map((p) => scored.get(p.row.man.playerId)!);
  console.log(
    `\nand against the room, on the ${withPrice.length} men it priced   spearman`,
  );

  for (const [label, of] of ways) {
    console.log(
      "  " + label.padEnd(32) +
      spearman(withPrice.map((p) => of(p.row)), pricedTruth).toFixed(4).padStart(7),
    );
  }

  console.log(
    "  where the room drafted him      " +
    spearman(withPrice.map((p) => -p.adp!), pricedTruth).toFixed(4).padStart(7),
  );

  // who the two disagree about most
  const ranked = (values: number[]) => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const place = new Array<number>(values.length);
    order.forEach((o, rank) => { place[o.i] = rank + 1; });
    return place;
  };

  const oldPlace = ranked(forBoard.map(ways[0]![1]));
  const newPlace = ranked(forBoard.map(ways[2]![1]));
  const realPlace = ranked(truth);
  const moves = forBoard.map((r, i) => ({
    name: names.get(r.man.playerId) ?? r.man.playerId,
    position: r.man.position, team: r.man.team,
    old: oldPlace[i]!, fresh: newPlace[i]!, was: realPlace[i]!,
    better: Math.abs(oldPlace[i]! - realPlace[i]!) - Math.abs(newPlace[i]! - realPlace[i]!),
  })).filter((m) => m.was <= 120 || m.old <= 120 || m.fresh <= 120);

  const show = (list: typeof moves, title: string) => {
    console.log(`\n${title}`);
    console.log("  player                pos  old  new  really");

    for (const m of list) {
      console.log(
        "  " + m.name.padEnd(21) + m.position.padEnd(4) +
        String(m.old).padStart(4) + String(m.fresh).padStart(5) +
        String(m.was).padStart(7),
      );
    }
  };

  show([...moves].sort((a, b) => b.better - a.better).slice(0, 8), "where the new one helps");
  show([...moves].sort((a, b) => a.better - b.better).slice(0, 5), "where it hurts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

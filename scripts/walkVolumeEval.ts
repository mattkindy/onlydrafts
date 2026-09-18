/**
 * How much football the walk hands out, against how much there is.
 *
 * It reads a kept season and compares it with what that season really
 * had: the throws, the targets and the runs a team game across the
 * league, then the same per player by position and by tier. The ratio
 * is the number to read, since the claim being checked is that a busy
 * receiver runs at double.
 *
 * Run: npx tsx scripts/walkVolumeEval.ts 2023 2024 2025
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPlayerStats } from "../src/data/nflverse.js";

const ROOT = join(import.meta.dirname, "..");

interface Parts {
  targets: number; carries: number; passAtt: number; receptions: number;
  recYds: number; rushYds: number; passYds: number; passCmp: number;
  recTd: number; rushTd: number; passTd: number;
}

const zero = (): Parts => ({
  targets: 0, carries: 0, passAtt: 0, receptions: 0, recYds: 0,
  rushYds: 0, passYds: 0, passCmp: 0, recTd: 0, rushTd: 0, passTd: 0,
});

const add = (into: Parts, from: Partial<Parts>, times = 1) => {
  for (const key of Object.keys(into) as (keyof Parts)[]) {
    into[key] += (from[key] ?? 0) * times;
  }
};

const KEYS: (keyof Parts)[] = [
  "passAtt", "passYds", "carries", "rushYds", "targets", "receptions", "recYds",
];

async function oneSeason(season: number): Promise<void> {
  const kept = JSON.parse(await readFile(
    join(ROOT, "data", "kept", `played-${season}.json`), "utf8",
  )) as {
    runs: number; weeks: number;
    made: [string, Record<string, number>][];
    games: [string, number][];
    samples: [string, number[]][];
  };
  const made = new Map(kept.made);
  const dealtGames = new Map(kept.games);
  const dealt = new Map(
    kept.samples.map(([id, his]) => [id, his.length / Math.max(1, kept.runs)]),
  );

  const truth = new Map<string, { parts: Parts; games: number }>();
  const position = new Map<string, string>();
  const name = new Map<string, string>();
  const teamGames = new Map<string, Set<number>>();
  const teamParts = new Map<string, Parts>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18) {
      continue;
    }

    position.set(s.playerId, s.position);
    name.set(s.playerId, s.playerName);
    const his = truth.get(s.playerId) ?? { parts: zero(), games: 0 };
    add(his.parts, {
      targets: s.targets, carries: s.carries, passAtt: s.passing.attempts,
      passCmp: s.passing.completions, receptions: s.statLine.receptions,
      recYds: s.statLine.recYds, rushYds: s.statLine.rushYds,
      passYds: s.statLine.passYds, recTd: s.statLine.recTd,
      rushTd: s.statLine.rushTd, passTd: s.statLine.passTd,
    });
    his.games++;
    truth.set(s.playerId, his);

    const seen = teamGames.get(s.teamId) ?? new Set<number>();
    seen.add(s.week);
    teamGames.set(s.teamId, seen);
    const tp = teamParts.get(s.teamId) ?? zero();
    add(tp, {
      targets: s.targets, carries: s.carries, passAtt: s.passing.attempts,
      receptions: s.statLine.receptions, recYds: s.statLine.recYds,
      rushYds: s.statLine.rushYds, passYds: s.statLine.passYds,
    });
    teamParts.set(s.teamId, tp);
  }

  // league totals a team game, walk against life
  const walkTeam = zero();
  let walkPlayerGames = 0;
  const lifeTeam = zero();
  let lifeTeamGames = 0;

  for (const [, parts] of made) {
    add(walkTeam, parts as unknown as Parts);
  }

  for (const [, n] of dealtGames) {
    walkPlayerGames += n;
  }

  for (const [team, parts] of teamParts) {
    add(lifeTeam, parts);
    lifeTeamGames += teamGames.get(team)!.size;
  }

  // the walk deals every player the same number of weeks, so a team game
  // is the dealt weeks
  const walkWeeks = kept.weeks;
  const walkTeamGames = 32 * walkWeeks;

  console.log(`\n===== ${season} =====`);
  console.log(`walk: ${kept.runs} runs, ${walkWeeks} weeks, ` +
    `${made.size} players, ${walkPlayerGames} dealt player games`);
  console.log(`\nleague per team game (walk / life = ratio)`);

  for (const key of KEYS) {
    const w = walkTeam[key] / walkTeamGames;
    const l = lifeTeam[key] / lifeTeamGames;
    console.log(`  ${key.padEnd(11)} ${w.toFixed(2).padStart(8)} ` +
      `${l.toFixed(2).padStart(8)}  ${(w / l).toFixed(2)}`);
  }

  // per position, per tier, on players the walk saw and life gave 8+ games
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const rows: {
      id: string; walk: Parts; walkGames: number; life: Parts; lifeGames: number;
    }[] = [];

    for (const [playerId, parts] of made) {
      if (position.get(playerId) !== pos) {
        continue;
      }

      const his = truth.get(playerId);

      if (!his || his.games < 8) {
        continue;
      }

      rows.push({
        id: playerId,
        walk: parts as unknown as Parts,
        // the games the walk dealt him, not the fixtures on the
        // calendar: it takes him off the field for spells
        walkGames: dealt.get(playerId) ?? walkWeeks,
        life: his.parts,
        lifeGames: his.games,
      });
    }

    const busy = (p: Parts) =>
      pos === "QB" ? p.passAtt : p.targets + p.carries;
    rows.sort((a, b) => busy(b.life) / b.lifeGames - busy(a.life) / a.lifeGames);
    const tiers: [string, typeof rows][] = [
      ["top 12", rows.slice(0, 12)],
      ["13-24", rows.slice(12, 24)],
      ["25-48", rows.slice(24, 48)],
      ["rest", rows.slice(48)],
    ];
    console.log(`\n  ${pos}, per game, walk / life = ratio (${rows.length} players)`);
    const cols = pos === "QB"
      ? (["passAtt", "passCmp", "passYds", "passTd", "carries", "rushYds"] as (keyof Parts)[])
      : (["targets", "receptions", "recYds", "carries", "rushYds", "recTd"] as (keyof Parts)[]);
    console.log("    tier      n  " + cols.map((c) => c.padStart(16)).join(""));

    for (const [label, tier] of tiers) {
      if (!tier.length) {
        continue;
      }

      const cells = cols.map((col) => {
        const w = tier.reduce((s, r) => s + r.walk[col], 0) /
          tier.reduce((s, r) => s + r.walkGames, 0);
        const l = tier.reduce((s, r) => s + r.life[col], 0) /
          tier.reduce((s, r) => s + r.lifeGames, 0);
        return `${w.toFixed(1)}/${l.toFixed(1)}=${(w / Math.max(1e-9, l)).toFixed(2)}`
          .padStart(16);
      });
      console.log(`    ${label.padEnd(7)} ${String(tier.length).padStart(3)}  ` +
        cells.join(""));
    }
  }

  /**
   * A player's targets a game against his own, for the men the walk
   * throws at most. Ordering the tiers by what a player really did
   * cannot see this: the walk picks its own busiest men, and they are
   * not always the ones a season made busy.
   */
  const paired = [...made.entries()]
    .filter(([id]) => ["WR", "TE"].includes(position.get(id) ?? ""))
    .map(([id, parts]) => ({
      walk: (parts["targets"] ?? 0) / Math.max(1, dealt.get(id) ?? walkWeeks),
      life: (truth.get(id)?.parts.targets ?? 0) /
        Math.max(1, truth.get(id)?.games ?? 1),
      games: truth.get(id)?.games ?? 0,
    }))
    .filter((p) => p.games >= 8 && p.life > 0);
  const ratios = paired.map((p) => p.walk / p.life).sort((a, b) => a - b);
  const byWalk = [...paired].sort((a, b) => b.walk - a.walk).slice(0, 24);
  const mean = (values: number[]) =>
    values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
  console.log(
    `\n  targets a game, receivers with eight games or more: median ratio ` +
    `${ratios[Math.floor(ratios.length / 2)]!.toFixed(2)} over ${ratios.length}, ` +
    `and ${mean(byWalk.map((p) => p.walk / p.life)).toFixed(2)} over the 24 ` +
    `the walk throws at most`,
  );

  // the men the walk throws at most, which is where the claim started
  const busiest = [...made.entries()]
    .filter(([id]) => ["WR", "TE", "RB"].includes(position.get(id) ?? ""))
    .sort((a, b) => (b[1]["targets"] ?? 0) - (a[1]["targets"] ?? 0))
    .slice(0, 8);
  console.log("\n  the men the walk throws at most:");

  for (const [id, parts] of busiest) {
    const his = truth.get(id);
    const targets = parts["targets"] ?? 0;
    const games = dealt.get(id) ?? walkWeeks;
    console.log(`    ${(name.get(id) ?? id).padEnd(22)} ` +
      `walk ${targets.toFixed(0).padStart(4)} targets in ` +
      `${games.toFixed(1)} games, life ` +
      `${(his?.parts.targets ?? 0).toFixed(0).padStart(4)} in ` +
      `${his?.games ?? 0}`);
  }
}

for (const season of process.argv.slice(2).map(Number)) {
  await oneSeason(season);
}

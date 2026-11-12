/**
 * Where does a card's spread come from when the walk never dealt him a
 * game?
 *
 * The board takes a player's band from three places in turn: the games
 * the walk dealt him, then the role simulation (`fitRoles` with
 * `seasonSim`, the four situations), then the pooled residual band that
 * gives every player at a level the same range. Only the first is the
 * model the rest of the board is built from. The role simulation is the
 * last thing that keeps the four situations alive, and it only ever
 * speaks for the men outside the walk's cast.
 *
 * So this asks, of exactly those men, whether the role simulation's
 * band is any better than the pooled one. Each is hung on the same
 * August level, as the board hangs them, and scored on the weeks he
 * really played: how often the 80% and the 50% bands held him, how wide
 * the 80% band was, and the pinball loss over the five quantiles the
 * card shows, which rewards a band for being right and narrow at once.
 * A third answer keeps to the walk: a man it never dealt a game borrows
 * the shape of the walk's men at his position nearest him in level.
 * The men neither source knows, mostly rookies, take the pooled band
 * today and are scored against the borrowed one too. The walk's own men
 * are scored the same way beside them, as a check that the instrument
 * can tell a better band from a worse one.
 *
 * A gap in pinball loss comes with its standard error, from resampling
 * the men, since a man's weeks are not independent of each other.
 *
 * Run: npx tsx scripts/bandSourceEval.ts [seasons, comma separated]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { buildPreseasonWorld } from "../src/features/preseason.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { simulateSeason, DEFAULT_SEASON } from "../src/model/seasonSim.js";
import { DEALT_WIDER } from "../src/features/walkWeek.js";
import { outcomeQuantile } from "../src/backtest/intervals.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";

const SEASONS = (process.argv[2] ?? "2023,2024,2025").split(",").map(Number);
const POSITIONS = ["QB", "RB", "WR", "TE"];
const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9] as const;
/** fewer played weeks than this and a man's coverage is one or two coin flips */
const MIN_WEEKS = 4;
/** how many of the walk's men at a position a borrowed shape is the median of */
const BORROW_FROM = Number(process.env["BORROW_FROM"] ?? 12);

type Shape = Record<(typeof QUANTILES)[number], number>;

interface Tally {
  players: number;
  weeks: number;
  in80: number;
  in50: number;
  width80: number;
  pinball: number;
  /** each man's weeks and pinball, in the order he was scored */
  men: { weeks: number; pinball: number }[];
}

const blank = (): Tally => ({
  players: 0, weeks: 0, in80: 0, in50: 0, width80: 0, pinball: 0, men: [],
});

const pinball = (q: number, at: number, was: number) =>
  was >= at ? q * (was - at) : (1 - q) * (at - was);

function score(into: Tally, band: Shape, weeks: number[]): void {
  into.players++;
  const his = { weeks: 0, pinball: 0 };
  into.men.push(his);

  for (const was of weeks) {
    his.weeks++;

    for (const q of QUANTILES) {
      his.pinball += pinball(q, band[q], was) / QUANTILES.length;
    }

    into.weeks++;
    into.width80 += band[0.9] - band[0.1];

    if (was >= band[0.1] && was <= band[0.9]) into.in80++;
    if (was >= band[0.25] && was <= band[0.75]) into.in50++;

    for (const q of QUANTILES) {
      into.pinball += pinball(q, band[q], was) / QUANTILES.length;
    }
  }
}

const say = (label: string, t: Tally) =>
  console.log(
    `  ${label.padEnd(22)} ${String(t.players).padStart(4)} men ` +
      `${String(t.weeks).padStart(5)} weeks  ` +
      `80% holds ${(100 * t.in80 / Math.max(1, t.weeks)).toFixed(1)}%  ` +
      `50% holds ${(100 * t.in50 / Math.max(1, t.weeks)).toFixed(1)}%  ` +
      `80% width ${(t.width80 / Math.max(1, t.weeks)).toFixed(2)}  ` +
      `pinball ${(t.pinball / Math.max(1, t.weeks)).toFixed(4)}`,
  );

/**
 * How much lower the second arm's pinball loss is than the first's,
 * scored on the same men, and the standard error of that from drawing
 * the men again with replacement.
 */
function gap(label: string, a: Tally, b: Tally): void {
  const of = (t: Tally, picks: number[]) => {
    let weeks = 0;
    let loss = 0;

    for (const i of picks) {
      weeks += t.men[i]!.weeks;
      loss += t.men[i]!.pinball;
    }

    return loss / Math.max(1, weeks);
  };
  const everyone = a.men.map((_, i) => i);
  const said = of(a, everyone) - of(b, everyone);
  const rng = seededRng(41);
  const draws: number[] = [];

  for (let n = 0; n < 2000; n++) {
    const picks = everyone.map(() => Math.floor(rng() * everyone.length));
    draws.push(of(a, picks) - of(b, picks));
  }

  const mean = draws.reduce((x, y) => x + y, 0) / draws.length;
  const se = Math.sqrt(draws.reduce((x, y) => x + (y - mean) ** 2, 0) / (draws.length - 1));

  console.log(`  ${label.padEnd(44)} ${said >= 0 ? "+" : ""}${said.toFixed(4)}, se ${se.toFixed(4)}`);
}

const ARMS = [
  "role", "pooled", "borrowed", "neitherPooled", "neitherBorrowed", "walk", "walkPooled",
] as const;
type Arm = (typeof ARMS)[number];
const tallies = () => Object.fromEntries(ARMS.map((a) => [a, blank()])) as Record<Arm, Tally>;
const all = tallies();

/** the median of each quantile over the nearest of the walk's men, by level */
function borrowedShape(
  position: string, level: number,
  dealt: { position: string; level: number; shape: Shape }[],
): Shape | undefined {
  const near = dealt.filter((d) => d.position === position)
    .sort((a, b) => Math.abs(a.level - level) - Math.abs(b.level - level))
    .slice(0, BORROW_FROM);

  if (near.length === 0) {
    return undefined;
  }

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)]!;
  };

  return Object.fromEntries(QUANTILES.map((q) =>
    [q, median(near.map((d) => d.shape[q]))])) as unknown as Shape;
}

function report(label: string, tally: Record<Arm, Tally>): void {
  console.log(`${label}, the men the walk never dealt a game, whose band the role simulation writes:`);
  say("role simulation", tally.role);
  say("pooled band", tally.pooled);
  say("borrowed from the walk", tally.borrowed);
  gap("pinball the pooled band saves on the role's", tally.role, tally.pooled);
  gap("and borrowing saves on the pooled band's", tally.pooled, tally.borrowed);
  console.log(" the men neither knows, who take the pooled band today:");
  say("pooled band", tally.neitherPooled);
  say("borrowed from the walk", tally.neitherBorrowed);
  gap("pinball borrowing saves on the pooled band's", tally.neitherPooled, tally.neitherBorrowed);
  console.log(" the walk's own men, the same instrument:");
  say("walk's dealt games", tally.walk);
  say("pooled band", tally.walkPooled);
}

for (const season of SEASONS) {
  const world = await buildPreseasonWorld(season);

  // the role simulation's shapes, built the way the board built them
  const positions = new Map<string, string>();
  const gamesLast = new Map<string, number>();

  for (const row of await loadPlayerStats(season - 1)) {
    positions.set(row.playerId, row.position);
    gamesLast.set(row.playerId, (gamesLast.get(row.playerId) ?? 0) + 1);
  }

  const roleShape = new Map<string, Shape>();
  const { byTeam, playsByTeam } = await fitRoles(season - 1, positions, gamesLast);
  const rng = seededRng(29);
  const draws = { uniform: rng, normal: () => normalDraw(rng) };

  for (const [team, roster] of byTeam) {
    const simulated = simulateSeason(
      { plays: playsByTeam.get(team)! }, roster,
      { ...DEFAULT_SEASON, runs: 400, roleDrift: 0, scoring: presets.ppr }, draws,
    );

    for (const player of simulated) {
      const mean = player.weekly.mean;

      if (mean <= 0) {
        continue;
      }

      roleShape.set(player.playerId, {
        0.1: player.weekly.p10 / mean,
        0.25: player.weekly.p25 / mean,
        0.5: player.weekly.median / mean,
        0.75: player.weekly.p75 / mean,
        0.9: player.weekly.p90 / mean,
      });
    }
  }

  // and the walk's, from the games it dealt him
  const walkShape = new Map<string, Shape>();
  const kept = JSON.parse(await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${season}.json`), "utf8",
  )) as { samples?: [string, number[]][] };

  for (const [playerId, his] of kept.samples ?? []) {
    if (his.length < 40) {
      continue;
    }

    const sorted = [...his].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.floor(q * (sorted.length - 1))]!;
    const middle = at(0.5);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;

    if (mean <= 0) {
      continue;
    }

    const stretched = (q: number) =>
      Math.max(0, middle + (at(q) - middle) * DEALT_WIDER) / mean;
    walkShape.set(playerId, {
      0.1: stretched(0.1), 0.25: stretched(0.25), 0.5: stretched(0.5),
      0.75: stretched(0.75), 0.9: stretched(0.9),
    });
  }

  const weekly = new Map<string, number[]>();

  for (const s of await loadPlayerStats(season)) {
    weekly.set(s.playerId, [
      ...(weekly.get(s.playerId) ?? []), fantasyPoints(s.statLine, presets.ppr),
    ]);
  }

  const tally = tallies();
  const dealt = world.players
    .filter((p) => walkShape.has(p.playerId) && p.projectedPpg > 0)
    .map((p) => ({ position: p.position, level: p.projectedPpg, shape: walkShape.get(p.playerId)! }));

  for (const p of world.players) {
    const was = weekly.get(p.playerId) ?? [];

    if (!POSITIONS.includes(p.position) || p.projectedPpg <= 0 || was.length < MIN_WEEKS) {
      continue;
    }

    const hung = (shape: Shape): Shape => ({
      0.1: Math.max(0, p.projectedPpg * shape[0.1]),
      0.25: Math.max(0, p.projectedPpg * shape[0.25]),
      0.5: Math.max(0, p.projectedPpg * shape[0.5]),
      0.75: Math.max(0, p.projectedPpg * shape[0.75]),
      0.9: Math.max(0, p.projectedPpg * shape[0.9]),
    });
    const pooled = Object.fromEntries(QUANTILES.map((q) => [
      q, Math.max(0, outcomeQuantile(world.residuals, p.position, p.projectedPpg, q)),
    ])) as unknown as Shape;

    const walk = walkShape.get(p.playerId);
    const role = roleShape.get(p.playerId);

    const borrowed = borrowedShape(p.position, p.projectedPpg, dealt);

    if (walk) {
      score(tally.walk, hung(walk), was);
      score(tally.walkPooled, pooled, was);
    } else if (role && borrowed) {
      score(tally.role, hung(role), was);
      score(tally.pooled, pooled, was);
      score(tally.borrowed, hung(borrowed), was);
    } else if (!role && borrowed) {
      score(tally.neitherPooled, pooled, was);
      score(tally.neitherBorrowed, hung(borrowed), was);
    }
  }

  report(String(season), tally);

  for (const key of ARMS) {
    for (const field of ["players", "weeks", "in80", "in50", "width80", "pinball"] as const) {
      all[key][field] += tally[key][field];
    }

    all[key].men.push(...tally[key].men);
  }
}

if (SEASONS.length > 1) {
  report(`all of ${SEASONS.join(", ")}`, all);
}

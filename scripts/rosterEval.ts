// The composition experiment: a challenger drafts risk-aware while
// eleven teams draft by ADP, scored in simulated wins against the same
// challenger drafting by pure projection order.
// Run: npx tsx scripts/rosterEval.ts --season 2025

import { buildPreseasonWorld } from "../src/features/preseason.js";
import { simulatePreseasonLeague } from "../src/sim/preseasonLeague.js";
import { seededRng } from "../src/sim/rng.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import type { SeasonPlayer } from "../src/sim/playerSeason.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import { predictRidge } from "../src/backtest/ridge.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { pickLineup } from "../src/sim/lineup.js";

const TEAMS = 12;
const SIMS = 400;
const ROSTER_LIMITS: Record<string, number> = { QB: 2, RB: 4, WR: 4, TE: 2 };
const ROSTER_SIZE = 10;

function argOf(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}

function snakeOrder(round: number): number[] {
  const order = Array.from({ length: TEAMS }, (_, i) => i);
  return round % 2 === 0 ? order : order.reverse();
}

type Picker = (
  available: SeasonPlayer[],
  roster: SeasonPlayer[],
  rng: () => number,
) => SeasonPlayer | undefined;

/** most drafters take near the top of the board; some reach */
const noisyAdpPick: Picker = (available, _roster, rng) => {
  if (available.length === 0) {
    return undefined;
  }

  if (rng() < 0.1) {
    return available[Math.floor(rng() * Math.min(12, available.length))];
  }

  const weights = [0.45, 0.25, 0.15, 0.1, 0.05];
  let u = rng();

  for (let i = 0; i < weights.length; i++) {
    u -= weights[i]!;

    if (u <= 0) {
      return available[Math.min(i, available.length - 1)];
    }
  }

  return available[0];
};

function draft(
  ordered: SeasonPlayer[],
  pickers: Picker[],
  rng: () => number,
): string[][] {
  const rosters: SeasonPlayer[][] = Array.from({ length: TEAMS }, () => []);
  const counts = Array.from({ length: TEAMS }, () => new Map<string, number>());
  const taken = new Set<string>();

  const fits = (team: number, player: SeasonPlayer) =>
    !taken.has(player.playerId) &&
    (counts[team]!.get(player.position) ?? 0) <
      (ROSTER_LIMITS[player.position] ?? 0);

  for (let round = 0; round < ROSTER_SIZE; round++) {
    for (const team of snakeOrder(round)) {
      const available = ordered.filter((p) => fits(team, p));
      const player = pickers[team]!(available, rosters[team]!, rng);

      if (!player) {
        continue;
      }

      rosters[team]!.push(player);
      counts[team]!.set(
        player.position,
        (counts[team]!.get(player.position) ?? 0) + 1,
      );
      taken.add(player.playerId);
    }
  }

  return rosters.map((r) => r.map((p) => p.playerId));
}

function fieldFor(challengerSlot: number, challenger: Picker, sharp: Picker): Picker[] {
  const pickers: Picker[] = Array.from({ length: TEAMS }, () => noisyAdpPick);
  pickers[challengerSlot] = challenger;
  pickers[(challengerSlot + 6) % TEAMS] = sharp;
  return pickers;
}

async function main(): Promise<void> {
  const season = argOf("--season", 2025);
  const world = await buildPreseasonWorld(season);
  const adp = await loadAdp(season);

  const adpOrdered = world.players
    .map((p) => ({
      p,
      adp: adp.get(`${normalizeName(p.name)}|${p.position}`)?.adp ?? 999,
    }))
    .filter((x) => x.adp < 999)
    .sort((a, b) => a.adp - b.adp)
    .map((x) => x.p);

  // replacement value per position, the board form that wins realized tests
  const REPLACEMENT_RANK: Record<string, number> = { QB: 20, RB: 40, WR: 40, TE: 16 };
  const replacement = new Map<string, number>();

  for (const position of Object.keys(REPLACEMENT_RANK)) {
    const list = world.players
      .filter((p) => p.position === position)
      .sort((a, b) => b.projectedPpg - a.projectedPpg);
    const at = list[Math.min(REPLACEMENT_RANK[position]!, list.length) - 1];
    replacement.set(position, at?.projectedPpg ?? 0);
  }

  const vorOf = (p: SeasonPlayer) =>
    p.projectedPpg - (replacement.get(p.position) ?? 0);

  const projectionPick: Picker = (available) =>
    [...available].sort((a, b) => vorOf(b) - vorOf(a))[0];

  const riskAwarePick: Picker = (available, roster) => {
    const sorted = [...available].sort((a, b) => vorOf(b) - vorOf(a));
    const best = sorted[0];

    if (!best) {
      return undefined;
    }

    const window = sorted.filter((p) => vorOf(best) - vorOf(p) <= 1.0);

    const byeCount = new Map<number, number>();

    for (const own of roster) {
      const bye = world.byeWeek.get(own.teamId);

      if (bye !== undefined) {
        byeCount.set(bye, (byeCount.get(bye) ?? 0) + 1);
      }
    }

    const meanGames = (p: SeasonPlayer) =>
      p.gamesPool.length === 0
        ? 14
        : p.gamesPool.reduce((s, x) => s + x, 0) / p.gamesPool.length;

    const score = (p: SeasonPlayer) => {
      const bye = world.byeWeek.get(p.teamId);
      const byePenalty = bye !== undefined ? (byeCount.get(bye) ?? 0) * 0.4 : 0;
      const sameTeam = roster.filter((own) => own.teamId === p.teamId).length;
      return meanGames(p) - byePenalty - sameTeam * 0.3;
    };

    return [...window].sort((a, b) => score(b) - score(a))[0];
  };

  const DRAFTS = 3;

  const report = (label: string, picker: Picker) => {
    let challengerSum = 0;
    let fieldSum = 0;
    let playoffSum = 0;
    let titleSum = 0;
    let count = 0;

    for (let slot = 0; slot < TEAMS; slot++) {
      for (let d = 0; d < DRAFTS; d++) {
        const draftRng = seededRng(slot * 100 + d + 1);
        const rosters = draft(
          adpOrdered,
          fieldFor(slot, picker, projectionPick),
          draftRng,
        );
        const result = simulatePreseasonLeague(
          world.playersById,
          rosters,
          season,
          world.games,
          world.residuals,
          world.oppAdjust,
          world.catcherLoading,
          world.seasonNoise,
          SIMS,
          seededRng(slot * 7 + d + 1),
        );

        const mean = (team: number) =>
          result.winsPerSim[team]!.reduce((s, x) => s + x, 0) / SIMS;
        challengerSum += mean(slot);
        playoffSum += result.playoffs[slot]! / SIMS;
        titleSum += result.titles[slot]! / SIMS;
        let others = 0;

        for (let team = 0; team < TEAMS; team++) {
          if (team !== slot) {
            others += mean(team);
          }
        }

        fieldSum += others / (TEAMS - 1);
        count++;
      }
    }

    console.log(
      `${label.padEnd(24)} ${(challengerSum / count).toFixed(2)} wins vs field ${(fieldSum / count).toFixed(2)}, playoffs ${((playoffSum / count) * 100).toFixed(0)}%, title ${((titleSum / count) * 100).toFixed(1)}%`,
    );
  };

  console.log(
    `${season}: noisy ADP field with one sharp opponent on our board, challenger rotated through all slots`,
  );
  report("adp order (control)", (available) => available[0]);
  report("model + replacement", projectionPick);
  report("model + repl + risk", riskAwarePick);

  // the same drafts scored against the season that actually happened
  const stats = await loadPlayerStats(season);
  const actualWeekly = new Map<string, number>();

  for (const row of stats) {
    if (row.week <= 14) {
      actualWeekly.set(
        `${row.playerId}|${row.week}`,
        fantasyPoints(row.statLine, presets.ppr),
      );
    }
  }

  const REALIZED_DRAFTS = 12;

  // recent actual form, the signal an owner manages by
  const recentForm = (playerId: string, week: number): number => {
    let sum = 0;
    let games = 0;

    for (let w = Math.max(1, week - 3); w < week; w++) {
      const points = actualWeekly.get(`${playerId}|${w}`);

      if (points !== undefined) {
        sum += points;
        games++;
      }
    }

    return games === 0 ? 0 : sum / games;
  };

  const seasonWeekly = await weeklyExamplesForSeason(season, world.games);
  const modelPred = new Map<string, number>();

  for (const e of seasonWeekly) {
    modelPred.set(
      `${e.playerId}|${e.week}`,
      predictRidge(world.weeklyWeights, weeklyRow(e)),
    );
  }

  const realized = (label: string, picker: Picker, modelManaged = false) => {
    let challengerSum = 0;
    let fieldSum = 0;
    let count = 0;
    const byProfile = new Map<number, { wins: number; teams: number }>();

    for (let slot = 0; slot < TEAMS; slot++) {
      for (let d = 0; d < REALIZED_DRAFTS; d++) {
      const manageRng = seededRng(slot * 1000 + d + 500);
      const rosters = draft(
        adpOrdered,
        fieldFor(slot, picker, projectionPick),
        seededRng(slot * 1000 + d + 1),
      ).map((r) => [...r]);
      const wins = new Array<number>(TEAMS).fill(0);
      const rostered = new Set(rosters.flat());

      // manager profiles: challenger and the sharp rival stay active,
      // the rest split into active, casual, and asleep
      const profiles: { threshold: number; act: number }[] = [];
      const others = [
        ...Array(3).fill({ threshold: 3, act: 1 }),
        ...Array(4).fill({ threshold: 6, act: 0.5 }),
        ...Array(3).fill({ threshold: Infinity, act: 0 }),
      ];

      for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(manageRng() * (i + 1));
        [others[i], others[j]] = [others[j], others[i]];
      }

      let cursor = 0;

      for (let team = 0; team < TEAMS; team++) {
        if (team === slot || team === (slot + 6) % TEAMS) {
          profiles.push({ threshold: 3, act: 1 });
        } else {
          profiles.push(others[cursor++]!);
        }
      }

      for (let w = 0; w < 14; w++) {
        const week = w + 1;

        // waiver claims from week 3, processed worst record first
        if (week >= 3) {
          const priority = Array.from({ length: TEAMS }, (_, t) => t).sort(
            (a, b) => wins[a]! - wins[b]!,
          );

          for (const team of priority) {
            const profile = profiles[team]!;

            if (manageRng() >= profile.act) {
              continue;
            }

            const roster = rosters[team]!;
            const freeAgents = world.players.filter(
              (p) => !rostered.has(p.playerId),
            );
            let best: { drop: string; add: string; gain: number } | undefined;

            const valueOf = (id: string): number =>
              modelManaged && team === slot
                ? modelPred.get(`${id}|${week}`) ?? recentForm(id, week)
                : recentForm(id, week);

            for (const p of roster) {
              const player = world.playersById.get(p)!;
              const own = valueOf(p);

              for (const fa of freeAgents) {
                if (fa.position !== player.position) {
                  continue;
                }

                const gain = valueOf(fa.playerId) - own;

                if (gain > profile.threshold && (!best || gain > best.gain)) {
                  best = { drop: p, add: fa.playerId, gain };
                }
              }
            }

            if (best) {
              roster[roster.indexOf(best.drop)] = best.add;
              rostered.delete(best.drop);
              rostered.add(best.add);
            }
          }
        }

        const teamPoints = rosters.map((roster, team) => {
          const scoreOf = (id: string): number => {
            if (week <= 2) {
              return world.playersById.get(id)!.projectedPpg;
            }

            if (modelManaged && team === slot) {
              return modelPred.get(`${id}|${week}`) ?? recentForm(id, week);
            }

            return recentForm(id, week);
          };

          const candidates = roster
            .filter((id) => actualWeekly.has(`${id}|${week}`))
            .map((id) => ({
              playerId: id,
              position: world.playersById.get(id)!.position,
              score: scoreOf(id),
            }));

          let points = 0;

          for (const starter of pickLineup(candidates)) {
            points += actualWeekly.get(`${starter}|${week}`) ?? 0;
          }

          return points;
        });

        const rotating = Array.from({ length: TEAMS - 1 }, (_, i) => i + 1);
        const shift = w % (TEAMS - 1);
        const ring = [0, ...rotating.slice(shift), ...rotating.slice(0, shift)];

        for (let i = 0; i < TEAMS / 2; i++) {
          const a = ring[i]!;
          const b = ring[TEAMS - 1 - i]!;

          if (teamPoints[a]! > teamPoints[b]!) {
            wins[a]!++;
          } else {
            wins[b]!++;
          }
        }
      }

      challengerSum += wins[slot]!;
      fieldSum +=
        wins.reduce((s, x, team) => (team === slot ? s : s + x), 0) / (TEAMS - 1);
      count++;

      for (let team = 0; team < TEAMS; team++) {
        if (team === slot || team === (slot + 6) % TEAMS) {
          continue;
        }

        const key = profiles[team]!.threshold;
        const entry = byProfile.get(key) ?? { wins: 0, teams: 0 };
        entry.wins += wins[team]!;
        entry.teams++;
        byProfile.set(key, entry);
      }
      }
    }

    const profileLabel = new Map([[3, "active"], [6, "casual"], [Infinity, "asleep"]]);
    const profileText = [...byProfile.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([key, { wins, teams }]) =>
          `${profileLabel.get(key)} ${(wins / teams).toFixed(2)}`,
      )
      .join(", ");
    console.log(
      `${label.padEnd(24)} ${(challengerSum / count).toFixed(2)} wins vs field ${(fieldSum / count).toFixed(2)}  (field by manager: ${profileText})`,
    );
  };

  console.log(
    `\nsame drafts against the ${season} season that happened, mixed managers and waiver priority:`,
  );
  realized("adp order (control)", (available) => available[0]);
  realized("model + replacement", projectionPick);
  realized("model + repl + risk", riskAwarePick);
  realized("risk board, model-managed", riskAwarePick, true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * How much of a player's role should carry into next season, and does
 * the answer depend on whether the staff that gave him the role is
 * still there?
 *
 * Fit the carry-over separately for men whose play-caller stayed and
 * men whose did not, rather than picking a shrinkage by hand. The
 * slope is the answer: a flat slope means last season says nothing.
 *
 * Run: npx tsx scripts/roleCarryoverEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadCoaches } from "../src/data/coaches.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { spearman, rmse } from "../src/backtest/metrics.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

interface Role {
  player: string; season: number; team: string; position: string;
  targetShare: number; carryShare: number; touches: number;
  sameStaff: boolean;
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const roles: Role[] = [];

  for (const season of SEASONS) {
    const stats = await loadPlayerStats(season);
    const teamTotals = new Map<string, { targets: number; carries: number }>();

    for (const s of stats) {
      const t = teamTotals.get(s.teamId) ?? { targets: 0, carries: 0 };
      t.targets += s.targets;
      t.carries += s.carries;
      teamTotals.set(s.teamId, t);
    }

    const byPlayer = new Map<string, { team: string; position: string; targets: number; carries: number }>();

    for (const s of stats) {
      const e = byPlayer.get(s.playerId) ??
        { team: s.teamId, position: s.position, targets: 0, carries: 0 };
      e.targets += s.targets;
      e.carries += s.carries;
      byPlayer.set(s.playerId, e);
    }

    for (const [player, e] of byPlayer) {
      const team = teamTotals.get(e.team)!;
      const oc = coaches.get(`${e.team}|${season}|OC`) ?? "";
      const hc = coaches.get(`${e.team}|${season}|HC`) ?? "";
      const ocBefore = coaches.get(`${e.team}|${season - 1}|OC`) ?? "";
      const hcBefore = coaches.get(`${e.team}|${season - 1}|HC`) ?? "";

      roles.push({
        player, season, team: e.team, position: e.position,
        targetShare: team.targets > 0 ? e.targets / team.targets : 0,
        carryShare: team.carries > 0 ? e.carries / team.carries : 0,
        touches: e.targets + e.carries,
        sameStaff: oc !== "" && ocBefore !== "" && oc === ocBefore && hc === hcBefore,
      });
    }
  }

  const byKey = new Map(roles.map((r) => [`${r.player}|${r.season}`, r]));
  const pairs: { prev: Role; next: Role }[] = [];

  for (const role of roles) {
    const prev = byKey.get(`${role.player}|${role.season - 1}`);

    if (prev && prev.position === role.position && prev.touches >= 40 && role.touches >= 20) {
      pairs.push({ prev, next: role });
    }
  }

  console.log(`${pairs.length} pairs\n`);
  console.log("how much of last season's role comes forward\n");
  console.log("position  what          group          n    slope   spearman");

  const report = (
    position: string, label: string,
    get: (r: Role) => number, group: (p: { prev: Role; next: Role }) => boolean,
    name: string,
  ) => {
    const sub = pairs.filter((p) => p.prev.position === position && group(p));

    if (sub.length < 30) {
      return;
    }

    // one feature, so the fitted weight is the slope
    const weights = fitRidge(
      sub.map((p) => [1, get(p.prev)]), sub.map((p) => get(p.next)), 0.001,
    );
    console.log(
      position.padEnd(10) + label.padEnd(14) + name.padEnd(15) +
      String(sub.length).padStart(4) + weights[1]!.toFixed(3).padStart(9) +
      spearman(sub.map((p) => get(p.prev)), sub.map((p) => get(p.next)))
        .toFixed(3).padStart(11),
    );
  };

  for (const [position, label, get] of [
    ["RB", "carry share", (r: Role) => r.carryShare],
    ["WR", "target share", (r: Role) => r.targetShare],
    ["TE", "target share", (r: Role) => r.targetShare],
  ] as [string, string, (r: Role) => number][]) {
    report(position, label, get, (p) => p.next.sameStaff, "staff kept");
    report(position, label, get, (p) => !p.next.sameStaff, "staff changed");
  }

  // does splitting the fit beat one fit for everyone, out of sample?
  console.log("\nout of sample on 2025, predicting a back's carry share\n");
  const backs = pairs.filter((p) => p.prev.position === "RB");
  const train = backs.filter((p) => p.next.season < 2025);
  const test = backs.filter((p) => p.next.season === 2025);
  const row = (r: Role) => [1, r.carryShare];
  const one = fitRidge(train.map((p) => row(p.prev)), train.map((p) => p.next.carryShare), 0.001);
  const kept = train.filter((p) => p.next.sameStaff);
  const moved = train.filter((p) => !p.next.sameStaff);
  const keptFit = fitRidge(kept.map((p) => row(p.prev)), kept.map((p) => p.next.carryShare), 0.001);
  const movedFit = fitRidge(moved.map((p) => row(p.prev)), moved.map((p) => p.next.carryShare), 0.001);

  const actual = test.map((p) => p.next.carryShare);
  const flat = test.map((p) => predictRidge(one, row(p.prev)));
  const aware = test.map((p) =>
    predictRidge(p.next.sameStaff ? keptFit : movedFit, row(p.prev)));

  console.log("  one fit for everyone      rmse " + rmse(flat, actual).toFixed(4) +
    "   spearman " + spearman(flat, actual).toFixed(3));
  console.log("  split by whether the      rmse " + rmse(aware, actual).toFixed(4) +
    "   spearman " + spearman(aware, actual).toFixed(3));
  console.log("  play-caller stayed        (" + test.length + " backs)");

  // The team-level measure said a backfield split resets with a new
  // staff while the player-level one says it does not. Both can hold
  // if what changes is which man leads, not how much a given man gets.
  const leadBy = new Map<string, { player: string; share: number }>();

  for (const role of roles) {
    if (role.position !== "RB") continue;
    const key = `${role.team}|${role.season}`;
    const best = leadBy.get(key);
    if (!best || role.carryShare > best.share) {
      leadBy.set(key, { player: role.player, share: role.carryShare });
    }
  }

  const staffOf = new Map<string, boolean>();

  for (const role of roles) {
    staffOf.set(`${role.team}|${role.season}`, role.sameStaff);
  }

  let keptSame = 0, keptTotal = 0, changedSame = 0, changedTotal = 0;

  for (const [key, lead] of leadBy) {
    const [team, season] = key.split("|");
    const before = leadBy.get(`${team}|${Number(season) - 1}`);
    if (!before) continue;
    const sameStaff = staffOf.get(key) ?? false;

    if (sameStaff) {
      keptTotal++;
      if (before.player === lead.player) keptSame++;
    } else {
      changedTotal++;
      if (before.player === lead.player) changedSame++;
    }
  }

  console.log("\ndoes the same man still lead the backfield?\n");
  console.log("  play-caller stayed    " +
    ((keptSame / keptTotal) * 100).toFixed(0) + "%  (" + keptTotal + " teams)");
  console.log("  play-caller changed   " +
    ((changedSame / changedTotal) * 100).toFixed(0) + "%  (" + changedTotal + " teams)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

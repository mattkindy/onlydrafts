/**
 * Where the played games disagreed hardest with the room, and who won.
 *
 * The simulation beats adp worst-to-best in every band of three
 * seasons, and a correlation says nothing about who. This lists the
 * men it moved furthest from their draft slot, both ways, with what
 * happened next to them.
 *
 * Run: npx tsx scripts/boldCalls.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;

async function main(): Promise<void> {
  const season = Number(process.argv[2] ?? 2025);
  const kept = JSON.parse(await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${season}.json`),
    "utf8",
  )) as { total: [string, number][]; games: [string, number][] };
  const walkSays = new Map(kept.total);
  const simGames = new Map(kept.games);

  const names = new Map<string, string>();
  const positions = new Map<string, string>();
  const scored = new Map<string, number>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 17) {
      continue;
    }

    names.set(s.playerId, s.playerName);
    positions.set(s.playerId, s.position);
    scored.set(
      s.playerId,
      (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const adp = await loadAdp(season, "ppr").catch(() => new Map());
  const men = [...walkSays.entries()]
    .filter(([id]) => (simGames.get(id) ?? 0) >= 10 && scored.has(id))
    .map(([id, points]) => ({
      id,
      name: names.get(id) ?? id,
      position: positions.get(id) ?? "",
      says: points,
      really: scored.get(id) ?? 0,
      adp: adp.get(
        `${normalizeName(names.get(id) ?? "")}|${positions.get(id) ?? ""}`,
      )?.adp ?? null,
    }))
    .filter((m) => m.adp !== null);

  const place = (of: (m: (typeof men)[number]) => number) => {
    const order = [...men].sort((a, b) => of(b) - of(a));
    const out = new Map<string, number>();
    order.forEach((m, i) => out.set(m.id, i + 1));
    return out;
  };
  const walkPlace = place((m) => m.says);
  const adpPlace = place((m) => -m.adp!);
  const truthPlace = place((m) => m.really);

  const calls = men.map((m) => ({
    ...m,
    walk: walkPlace.get(m.id)!,
    room: adpPlace.get(m.id)!,
    truth: truthPlace.get(m.id)!,
  }));

  const show = (list: typeof calls) => {
    for (const m of list) {
      const won =
        Math.abs(m.truth - m.walk) < Math.abs(m.truth - m.room)
          ? "the walk" : "the room";
      console.log(
        "  " + `${m.name} (${m.position})`.padEnd(28) +
          `adp ${String(Math.round(m.adp!)).padStart(3)}` +
          `   the walk said ${String(m.walk).padStart(3)} of ${calls.length}` +
          `   the room said ${String(m.room).padStart(3)}` +
          `   finished ${String(m.truth).padStart(3)}` +
          `   ${won} was closer`,
      );
    }
  };

  /**
   * The quarterback convention check. A one quarterback league drafts
   * them late because replacement is high, not because the room thinks
   * they score little, so a position blind rank hands the walk credit
   * for knowing quarterbacks score a lot. Within one position that
   * convention cancels.
   */
  const spearman = (a: number[], b: number[]) => {
    const rank = (v: number[]) => {
      const order = v.map((x, i) => ({ x, i })).sort((p, q) => q.x - p.x);
      const out = new Array<number>(v.length);
      order.forEach((o, r) => { out[o.i] = r + 1; });
      return out;
    };
    const ra = rank(a);
    const rb = rank(b);
    const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
    let up = 0;
    let da = 0;
    let db = 0;

    for (let i = 0; i < ra.length; i++) {
      up += (ra[i]! - ma) * (rb[i]! - ma);
      da += (ra[i]! - ma) ** 2;
      db += (rb[i]! - ma) ** 2;
    }

    return up / Math.sqrt(da * db);
  };

  console.log("within one position, so the convention cancels\n");
  console.log("  position    men   adp   the walk");

  for (const at of ["QB", "RB", "WR", "TE"]) {
    const these = men.filter((m) => m.position === at);

    if (these.length < 10) {
      continue;
    }

    console.log(
      "  " + at.padEnd(10) + String(these.length).padStart(4) +
        spearman(these.map((m) => -m.adp!), these.map((m) => m.really))
          .toFixed(3).padStart(8) +
        spearman(these.map((m) => m.says), these.map((m) => m.really))
          .toFixed(3).padStart(10),
    );
  }

  const skill = men.filter((m) => m.position !== "QB");
  console.log(
    "\n  all but the quarterbacks: adp " +
      spearman(skill.map((m) => -m.adp!), skill.map((m) => m.really)).toFixed(3) +
      ", the walk " +
      spearman(skill.map((m) => m.says), skill.map((m) => m.really)).toFixed(3) + "\n",
  );

  console.log(`${season}, ${calls.length} men both had an opinion on\n`);
  console.log("boldest calls upward, the walk against the room\n");
  show(
    [...calls].sort((a, b) => (b.room - b.walk) - (a.room - a.walk)).slice(0, 12),
  );
  console.log("\nboldest calls downward\n");
  show(
    [...calls].sort((a, b) => (b.walk - b.room) - (a.walk - a.room)).slice(0, 12),
  );

  // and the sleepers proper: late by the room, high by the walk, and
  // how the season came out for them
  console.log("\npast pick 100 by the room, top 25 by the walk\n");
  show(
    calls.filter((m) => m.adp! > 100 && m.walk <= 25)
      .sort((a, b) => a.walk - b.walk),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

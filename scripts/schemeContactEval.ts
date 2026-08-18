/**
 * Is a back's yards before contact his, his line's, or his scheme's?
 *
 * It is the steadiest thing he has, carrying to the next season at
 * .445. Yet when he changes teams it follows him at .162 and his new
 * team's other backs predict it at .074, both inside the noise. So it
 * belongs to something that breaks when he moves.
 *
 * If that something is the scheme, it should also break when the
 * coordinator leaves and the back stays, and travel when a back
 * follows his coordinator to a new team.
 *
 * Run: npx tsx scripts/schemeContactEval.ts
 */

import { spearman } from "../src/backtest/metrics.js";
import { loadCoaches } from "../src/data/coaches.js";
import {
  loadRushingSeasons, type RushingSeason,
} from "../src/data/advancedStats.js";

/** how far a rank correlation on this many pairs wanders by chance */
const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

/** the reference writes some sides differently from the play file */
const SAME_TEAM: Record<string, string> = {
  GNB: "GB", KAN: "KC", NOR: "NO", NWE: "NE", SFO: "SF", TAM: "TB",
  LVR: "LV", OAK: "LV", STL: "LA", SDG: "LAC", RAM: "LA", RAI: "LV",
  CRD: "ARI", RAV: "BAL", HTX: "HOU", CLT: "IND", OTI: "TEN",
};

const asTeam = (team: string) => SAME_TEAM[team] ?? team;

interface Pair {
  was: RushingSeason;
  now: RushingSeason;
  sameTeam: boolean;
  sameCoordinator: boolean;
  sameHeadCoach: boolean;
}

const carriedOn = (
  these: Pair[], of: (r: RushingSeason) => number,
): number => spearman(these.map((p) => of(p.was)), these.map((p) => of(p.now)));

function report(label: string, these: Pair[]): void {
  if (these.length < 8) {
    console.log(
      "  " + label.padEnd(34) + String(these.length).padStart(4) +
        "   too few to say",
    );
    return;
  }

  console.log(
    "  " + label.padEnd(34) + String(these.length).padStart(4) +
      carriedOn(these, (r) => r.beforeContact).toFixed(3).padStart(17) +
      carriedOn(these, (r) => r.afterContact).toFixed(3).padStart(16) +
      carriedOn(these, (r) => r.perCarry).toFixed(3).padStart(16) +
      noise(these.length).toFixed(3).padStart(15),
  );
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const byPlayer = new Map<string, Map<number, RushingSeason>>();

  for (const row of await loadRushingSeasons()) {
    const own = byPlayer.get(row.pfrId) ?? new Map<number, RushingSeason>();
    own.set(row.season, row);
    byPlayer.set(row.pfrId, own);
  }

  const staff = (team: string, season: number, role: string) =>
    coaches.get(`${asTeam(team)}|${season}|${role}`) ?? "";
  const pairs: Pair[] = [];
  let missing = 0;

  for (const own of byPlayer.values()) {
    for (const [season, was] of own) {
      const now = own.get(season + 1);

      if (!now) {
        continue;
      }

      const before = staff(was.team, season, "OC");
      const after = staff(now.team, season + 1, "OC");

      if (!before || !after) {
        missing++;
        continue;
      }

      pairs.push({
        was, now,
        sameTeam: asTeam(was.team) === asTeam(now.team),
        sameCoordinator: before === after,
        sameHeadCoach:
          staff(was.team, season, "HC") === staff(now.team, season + 1, "HC"),
      });
    }
  }

  console.log(
    `${pairs.length} back seasons back to back, ` +
      `${missing} dropped for want of a coordinator\n`,
  );
  console.log(
    "what carries to the next season, as rank correlation, more is better\n",
  );
  console.log(
    "  who                                 n   before contact   after contact" +
      "   yards a carry   give or take",
  );

  for (const [label, is] of [
    ["stayed, kept his coordinator", (p: Pair) => p.sameTeam && p.sameCoordinator],
    ["stayed, new coordinator", (p: Pair) => p.sameTeam && !p.sameCoordinator],
    ["moved, followed his coordinator", (p: Pair) => !p.sameTeam && p.sameCoordinator],
    ["moved, new coordinator", (p: Pair) => !p.sameTeam && !p.sameCoordinator],
  ] as [string, (p: Pair) => boolean][]) {
    report(label, pairs.filter(is));
  }

  // and the same question about the head coach, since a coordinator
  // often changes underneath one who stays
  console.log("\n  and by head coach, among the backs who stayed put\n");

  for (const [label, is] of [
    ["kept his head coach", (p: Pair) => p.sameTeam && p.sameHeadCoach],
    ["new head coach", (p: Pair) => p.sameTeam && !p.sameHeadCoach],
  ] as [string, (p: Pair) => boolean][]) {
    report(label, pairs.filter(is));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

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

  // and how far apart the two ends are, since a part that everybody
  // does the same is not worth carrying through the model
  const teams = new Map<string, { yards: number; carries: number }>();
  const backs = new Map<string, { yards: number; carries: number }>();

  for (const row of await loadRushingSeasons(20)) {
    for (const [into, key, part] of [
      [teams, `${asTeam(row.team)}|${row.season}`, row.beforeContact],
      [backs, row.pfrId, row.afterContact],
    ] as [Map<string, { yards: number; carries: number }>, string, number][]) {
      const own = into.get(key) ?? { yards: 0, carries: 0 };
      own.yards += part * row.attempts;
      own.carries += row.attempts;
      into.set(key, own);
    }
  }

  const spreadOf = (of: Map<string, { yards: number; carries: number }>) => {
    const rates = [...of.values()]
      .filter((one) => one.carries >= 100)
      .map((one) => one.yards / one.carries)
      .sort((a, b) => a - b);
    const mid = rates.reduce((a, b) => a + b, 0) / Math.max(1, rates.length);

    return {
      count: rates.length,
      middle: mid,
      low: rates[Math.floor(rates.length * 0.1)] ?? 0,
      high: rates[Math.floor(rates.length * 0.9)] ?? 0,
    };
  };

  console.log("\n  how far apart the two ends are, in yards a carry\n");

  for (const [label, of] of [
    ["before contact, by team season", teams],
    ["after contact, by back", backs],
  ] as [string, typeof teams][]) {
    const spread = spreadOf(of);
    console.log(
      "  " + label.padEnd(34) + String(spread.count).padStart(4) +
        `   middle ${spread.middle.toFixed(2)}` +
        `   a tenth are under ${spread.low.toFixed(2)}` +
        `   a tenth over ${spread.high.toFixed(2)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

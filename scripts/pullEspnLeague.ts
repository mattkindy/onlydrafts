/**
 * A private ESPN league, pulled here rather than in the browser.
 *
 * ESPN keeps a private league behind the cookies your sign in leaves
 * on espn.com, and a browser will only send those to a page on
 * espn.com. Javascript cannot set them by hand either, so the page
 * can read a public league and no more. This asks from here, where
 * the cookies can be set, and writes what the page needs.
 *
 * Find the two cookies in your browser on espn.com under application,
 * storage, cookies. SWID looks like {AAAA-BBBB}, espn_s2 is long.
 *
 * Run: ESPN_SWID='{...}' ESPN_S2='...' npx tsx scripts/pullEspnLeague.ts 829178711
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeName } from "../src/data/names.js";

const WHERE = join(import.meta.dirname, "..", "docs", "data");

/** what ESPN calls each thing it pays for */
const STATS: Record<number, string> = {
  3: "pass_yd", 4: "pass_td", 20: "int", 24: "rush_yd", 25: "rush_td",
  42: "rec_yd", 43: "rec_td", 53: "rec", 72: "fum_lost", 74: "xpm",
  77: "fgm_0_19", 80: "fgm_20_29", 83: "fgm_30_39", 86: "fgm_40_49",
  88: "fgm_50p", 89: "fgmiss_0_19", 95: "int", 96: "fum_rec", 97: "blk_kick",
  98: "safe", 99: "sack", 101: "def_td",
};

/** and what it calls the slots a lineup is made of */
const SLOTS: Record<number, string> = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DEF", 17: "K", 23: "FLEX", 7: "FLEX",
};

interface Team {
  id: number;
  name?: string;
  location?: string;
  nickname?: string;
  owners?: string[];
  roster?: { entries?: { playerPoolEntry?: { player?: {
    fullName?: string; defaultPositionId?: number;
  } } }[] };
}

async function main(): Promise<void> {
  const leagueId = process.argv[2];
  const season = Number(process.argv[3] ?? new Date().getFullYear());
  const swid = process.env["ESPN_SWID"] ?? "";
  const s2 = process.env["ESPN_S2"] ?? "";

  if (!leagueId) {
    console.error("give me a league id");
    process.exit(1);
  }

  const at = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/` +
    `${season}/segments/0/leagues/${leagueId}` +
    "?view=mTeam&view=mSettings&view=mRoster&view=mDraftDetail";
  const answered = await fetch(at, {
    headers: swid && s2 ? { cookie: `SWID=${swid}; espn_s2=${s2}` } : {},
  });

  if (answered.status === 401) {
    console.error(
      "ESPN says no. A private league needs ESPN_SWID and ESPN_S2 from " +
        "your browser, and they expire, so take them fresh.",
    );
    process.exit(1);
  }

  if (!answered.ok) {
    console.error(`ESPN answered ${answered.status} for that league`);
    process.exit(1);
  }

  const said = await answered.json() as {
    settings?: {
      name?: string;
      scoringSettings?: { scoringItems?: { statId: number; points: number }[] };
      rosterSettings?: { lineupSlotCounts?: Record<string, number> };
      draftSettings?: { type?: string; pickOrder?: number[] };
    };
    teams?: Team[];
  };
  const settings = said.settings ?? {};
  const scoring: Record<string, number> = {};

  for (const item of settings.scoringSettings?.scoringItems ?? []) {
    const named = STATS[item.statId];

    if (named) {
      scoring[named] = item.points ?? 0;
    }
  }

  const slots: string[] = [];

  for (const [slot, howMany] of Object.entries(
    settings.rosterSettings?.lineupSlotCounts ?? {},
  )) {
    const named = SLOTS[Number(slot)];

    for (let i = 0; named && i < howMany; i++) {
      slots.push(named);
    }
  }

  const nameOf = (team: Team) =>
    (team.name ?? [team.location, team.nickname].filter(Boolean).join(" "))
      .trim() || `team ${team.id}`;
  const menOf = (team: Team) => (team.roster?.entries ?? [])
    .map((e) => e.playerPoolEntry?.player)
    .filter((p): p is { fullName: string; defaultPositionId?: number } =>
      Boolean(p?.fullName))
    .map((p) => ({
      name: p.fullName,
      key: normalizeName(p.fullName),
      pos: SLOTS[p.defaultPositionId ?? -1] ?? "",
    }));
  const order = settings.draftSettings?.pickOrder ?? [];
  const rounds = 15;
  const everyRound = Array.from({ length: rounds }, (_, i) => i + 1);
  const teams = said.teams ?? [];

  const leagues = teams.map((team) => ({
    provider: "espn",
    leagueId: String(leagueId),
    name: (settings.name ?? "ESPN league") + " (" + nameOf(team) + ")",
    size: teams.length,
    scoring, slots,
    userId: String(team.id),
    team: nameOf(team),
    members: Object.fromEntries(teams.map((t) => [String(t.id), nameOf(t)])),
    myRoster: menOf(team),
    myPicks: everyRound,
    // where the order has him, when the draft has been set up
    draftSlot: order.indexOf(team.id) >= 0 ? order.indexOf(team.id) + 1 : null,
    snake: (settings.draftSettings?.type ?? "SNAKE") !== "AUCTION",
    allRosters: teams.map((t) => ({
      owner: nameOf(t), picks: everyRound, keys: menOf(t),
    })),
  }));

  await mkdir(WHERE, { recursive: true });
  const file = join(WHERE, `league-espn-${leagueId}.json`);
  await writeFile(file, JSON.stringify({ season, leagues }));
  console.log(
    `${settings.name ?? leagueId}: ${teams.length} teams, ` +
      `${slots.length} starters, ${Object.keys(scoring).length} scoring ` +
      `categories, written to ${file}`,
  );
  console.log(`teams: ${teams.map(nameOf).join(", ")}`);
}

await main();

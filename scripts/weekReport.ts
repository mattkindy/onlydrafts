/**
 * A week of football, played out and written up.
 *
 * Every game runs many times. The score, the odds and the box score
 * come from all the runs, so they say what is likely. The drive log
 * comes from one playthrough, so it agrees with itself the way an
 * afternoon of football does.
 *
 * Run: npx tsx scripts/weekReport.ts 2025 17
 *   RUNS, LIVE and HTML change how many times, what was known, and
 *   where the page is written.
 */

import { writeFile } from "node:fs/promises";
import { seededRng } from "../src/sim/rng.js";
import {
  loadGames, loadPlayerStats, loadWeeklyRosters,
} from "../src/data/nflverse.js";
import { buildWorld } from "../src/features/playedWorld.js";
import { sizeOf } from "../src/features/gameSize.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { playGame, linesFrom } from "../src/model/gameFromDrives.js";
import type { PlayedGame } from "../src/model/gameFromDrives.js";
import type { FactorDrive } from "../src/model/driveFromFactors.js";

const RULES = presets.standard;

/** what each drive ending is called out loud */
const ENDING_SAID: Record<string, string> = {
  touchdown: "touchdown",
  fieldGoal: "field goal",
  punt: "punt",
  turnover: "turnover",
  downs: "turned over on downs",
  halfEnded: "ran out of time",
  clockRanOut: "ran out of time",
};

interface ManLine {
  name: string;
  position: string;
  team: string;
  passYds: number; passTd: number; interceptions: number;
  rushYds: number; rushTd: number;
  receptions: number; recYds: number; recTd: number;
  points: number;
}

interface GameReport {
  home: string; away: string;
  meanHome: number; meanAway: number;
  homeWins: number;
  line?: { home: number; away: number };
  story: { headline: string; plays: string[] }[];
  men: ManLine[];
}

const blankMan = (name: string, position: string, team: string): ManLine => ({
  name, position, team,
  passYds: 0, passTd: 0, interceptions: 0,
  rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0, points: 0,
});

/**
 * Where the ball is, said the way people say it. The model counts
 * yards to the goal, so 75 is a man's own 25.
 */
const spotOf = (yardline: number) =>
  yardline > 50 ? `their own ${100 - yardline}` : `the ${yardline}`;

/** how a drive read, play by play */
function driveStory(
  drive: FactorDrive, team: string, startedAt: number,
  nameOf: (id: string) => string,
): { headline: string; plays: string[] } {
  const plays = drive.plays.map((play) => {
    const who = nameOf(play.player);
    const spot = `${play.state.down} and ${play.state.toGo}` +
      ` at ${spotOf(play.state.yardline)}`;

    if (play.call === "pass" && !play.caught) {
      return play.player
        ? `${spot}: incomplete for ${who}`
        : `${spot}: incomplete, nobody open`;
    }

    const made = play.call === "pass"
      ? `${who} caught it for ${play.yards}`
      : `${who} ran for ${play.yards}`;

    return `${spot}: ${made}${play.scored ? ", touchdown" : ""}`;
  });

  // where the first snap happened, since a kickoff moves the ball
  const from = drive.plays[0]?.state.yardline ?? startedAt;

  return {
    headline: `${team} from ${spotOf(from)}: ` +
      `${drive.plays.length} plays, ${ENDING_SAID[drive.ending] ?? drive.ending}`,
    plays,
  };
}

const rounded = (n: number) => n.toFixed(1);

async function main(): Promise<void> {
  const season = Number(process.argv[2] ?? 2025);
  const week = Number(process.argv[3] ?? 1);
  const runs = Number(process.env["RUNS"] ?? 200);
  const live = Boolean(process.env["LIVE"]);

  const positions = new Map<string, string>();
  const names = new Map<string, string>();

  for (const before of [season - 1, season]) {
    for (const s of await loadPlayerStats(before).catch(() => [])) {
      positions.set(s.playerId, s.position);
      names.set(s.playerId, s.playerName);
    }
  }

  // a man who never took a snap has no stat row, so the roster names him
  for (const row of await loadWeeklyRosters(season).catch(() => [])) {
    if (!names.has(row.playerId) && row.name) {
      names.set(row.playerId, row.name);
      positions.set(row.playerId, positions.get(row.playerId) ?? row.rawPosition);
    }
  }

  const nameOf = (id: string) => names.get(id) ?? id;
  const world = await buildWorld(season, week, live, positions);
  const schedule = (await loadGames())
    .filter((g) => g.season === season && g.week === week);
  const rng = seededRng(Number(process.env["SEED"] ?? 23));
  const reports: GameReport[] = [];

  for (const fixture of schedule) {
    const home = world.sideFor(fixture.homeTeamId);
    const away = world.sideFor(fixture.awayTeamId);

    if (!home || !away) {
      continue;
    }

    /**
     * The market's read on the size of the afternoon, at the strength
     * the sweep picked. With no line the game plays on what the walk
     * knows by itself.
     */
    const alpha = Number(process.env["ALPHA"] ?? 0.7);
    let implied: { home: number; away: number } | undefined;

    if (fixture.totalLine !== undefined && fixture.spreadLine !== undefined) {
      implied = {
        home: fixture.totalLine / 2 + fixture.spreadLine / 2,
        away: fixture.totalLine / 2 - fixture.spreadLine / 2,
      };
      home.lift = Math.pow(sizeOf(
        { total: fixture.totalLine, favouredBy: fixture.spreadLine },
      ), alpha);
      away.lift = Math.pow(sizeOf(
        { total: fixture.totalLine, favouredBy: -fixture.spreadLine },
      ), alpha);
    }

    const boxes = new Map<string, ManLine>();
    let homePoints = 0;
    let awayPoints = 0;
    let homeWins = 0;
    let shown: PlayedGame | undefined;

    for (let run = 0; run < runs; run++) {
      const game = playGame(home, away, {
        rules: { ...world.rules, kickSucceeds: world.kicking.kickSucceeds },
        fourth: world.fourth,
        clock: {
          isLast: world.kicking.isLast, lastLength: world.kicking.lastLength,
        },
        ticking: world.ticking, season, week,
      }, rng);

      homePoints += (game.points[home.team] ?? 0) / runs;
      awayPoints += (game.points[away.team] ?? 0) / runs;

      if ((game.points[home.team] ?? 0) > (game.points[away.team] ?? 0)) {
        homeWins++;
      }

      if (!shown) {
        shown = game;
      }

      for (const [playerId, line] of linesFrom(game, [home, away])) {
        const man = boxes.get(playerId) ??
          blankMan(
            nameOf(playerId), positions.get(playerId) ?? "",
            home.among.includes(playerId) ? home.team : away.team,
          );
        man.passYds += (line.passYds ?? 0) / runs;
        man.passTd += (line.passTd ?? 0) / runs;
        man.interceptions += (line.interceptions ?? 0) / runs;
        man.rushYds += (line.rushYds ?? 0) / runs;
        man.rushTd += (line.rushTd ?? 0) / runs;
        man.receptions += (line.receptions ?? 0) / runs;
        man.recYds += (line.recYds ?? 0) / runs;
        man.recTd += (line.recTd ?? 0) / runs;
        man.points += fantasyPoints(line, RULES) / runs;
        boxes.set(playerId, man);
      }
    }

    reports.push({
      home: home.team, away: away.team,
      meanHome: homePoints, meanAway: awayPoints,
      homeWins: homeWins / runs,
      line: implied,
      story: (shown?.possessions ?? []).map((one) =>
        driveStory(one.drive, one.team, one.startedAt, nameOf)),
      men: [...boxes.values()]
        .filter((m) => m.points >= 1)
        .sort((a, b) => b.points - a.points),
    });
  }

  for (const game of reports) {
    console.log(
      `\n=== ${game.away} at ${game.home}   ` +
        `${rounded(game.meanAway)} to ${rounded(game.meanHome)}   ` +
        `${game.home} wins ${(100 * game.homeWins).toFixed(0)}%` +
        (game.line
          ? `   (the line said ${rounded(game.line.away)} to ` +
            `${rounded(game.line.home)})`
          : ""),
    );
    console.log("\nhow one playthrough went:");

    for (const drive of game.story) {
      console.log(`  ${drive.headline}`);

      for (const play of drive.plays) {
        console.log(`      ${play}`);
      }
    }

    console.log("\nthe box score, averaged over every run:");

    for (const man of game.men.slice(0, 14)) {
      const bits: string[] = [];

      if (man.passYds >= 1) {
        bits.push(`${rounded(man.passYds)} passing, ` +
          `${man.passTd.toFixed(1)} td, ${man.interceptions.toFixed(1)} int`);
      }

      if (man.rushYds >= 1) {
        bits.push(`${rounded(man.rushYds)} rushing, ${man.rushTd.toFixed(1)} td`);
      }

      if (man.receptions >= 0.5) {
        bits.push(`${man.receptions.toFixed(1)} for ${rounded(man.recYds)}, ` +
          `${man.recTd.toFixed(1)} td`);
      }

      console.log(
        `  ${man.name.padEnd(22)} ${man.position.padEnd(3)} ` +
          `${rounded(man.points).padStart(5)} pts   ${bits.join("; ")}`,
      );
    }
  }

  if (process.env["HTML"]) {
    await writeFile(process.env["HTML"], page(reports, season, week));
    console.log(`\npage written to ${process.env["HTML"]}`);
  }
}

function page(reports: GameReport[], season: number, week: number): string {
  const games = reports.map((game) => `
  <article class="game">
    <header>
      <div class="score">
        <span class="team">${game.away}</span>
        <span class="pts">${rounded(game.meanAway)}</span>
        <span class="at">at</span>
        <span class="pts">${rounded(game.meanHome)}</span>
        <span class="team">${game.home}</span>
      </div>
      <p class="odds">${game.home} wins ${(100 * game.homeWins).toFixed(0)}% of
      the time${game.line
        ? `, and the market had it ${rounded(game.line.away)} to ` +
          `${rounded(game.line.home)}`
        : ""}.</p>
    </header>
    <div class="cols">
      <section>
        <h3>One way it goes</h3>
        <ol class="drives">
          ${game.story.map((d) => `<li><b>${d.headline}</b>
            <ul>${d.plays.map((p) => `<li>${p}</li>`).join("")}</ul></li>`)
            .join("")}
        </ol>
      </section>
      <section>
        <h3>Box score</h3>
        <div class="scroll"><table>
          <thead><tr><th>player</th><th>pts</th><th>pass</th><th>rush</th>
          <th>rec</th></tr></thead>
          <tbody>
          ${game.men.slice(0, 16).map((m) => `<tr>
            <td>${m.name} <span class="pos">${m.position}</span></td>
            <td class="n">${rounded(m.points)}</td>
            <td class="n">${m.passYds >= 1 ? rounded(m.passYds) : ""}</td>
            <td class="n">${m.rushYds >= 1 ? rounded(m.rushYds) : ""}</td>
            <td class="n">${m.receptions >= 0.5
              ? `${m.receptions.toFixed(1)}/${rounded(m.recYds)}` : ""}</td>
          </tr>`).join("")}
          </tbody>
        </table></div>
      </section>
    </div>
  </article>`).join("");

  return `<title>Week ${week} Playthrough</title>
<style>
  :root {
    --ground: #fbfaf7; --card: #ffffff; --ink: #1a1c1a; --soft: #5c625c;
    --rule: #e2e0d8; --mark: #2f6b4f; --warm: #b4622e;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #141615; --card: #1d201e; --ink: #eceae4; --soft: #9aa39c;
      --rule: #2e332f; --mark: #6fbf94; --warm: #d8895a;
    }
  }
  :root[data-theme="dark"] {
    --ground: #141615; --card: #1d201e; --ink: #eceae4; --soft: #9aa39c;
    --rule: #2e332f; --mark: #6fbf94; --warm: #d8895a;
  }
  body {
    background: var(--ground); color: var(--ink); margin: 0;
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
    padding: 2rem 1.25rem 4rem;
  }
  .wrap { max-width: 68rem; margin: 0 auto; display: flex;
    flex-direction: column; gap: 1.5rem; }
  h1 { font-size: 1.6rem; margin: 0; letter-spacing: -0.01em; }
  .lede { color: var(--soft); margin: 0.35rem 0 0; max-width: 46rem; }
  .game { background: var(--card); border: 1px solid var(--rule);
    border-radius: 10px; padding: 1.1rem 1.25rem; }
  .score { display: flex; align-items: baseline; gap: 0.6rem;
    font-variant-numeric: tabular-nums; flex-wrap: wrap; }
  .team { font-weight: 650; font-size: 1.15rem; }
  .pts { font-size: 1.5rem; font-weight: 700; color: var(--mark); }
  .at { color: var(--soft); font-size: 0.85rem; }
  .odds { color: var(--soft); margin: 0.3rem 0 0; font-size: 0.92rem; }
  .cols { display: grid; grid-template-columns: 1fr; gap: 1.25rem;
    margin-top: 1rem; }
  @media (min-width: 60rem) { .cols { grid-template-columns: 1.15fr 1fr; } }
  h3 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--soft); margin: 0 0 0.5rem; }
  .drives { margin: 0; padding-left: 1.1rem; font-size: 0.9rem; }
  .drives > li { margin-bottom: 0.5rem; }
  .drives ul { margin: 0.2rem 0 0; padding-left: 1rem; color: var(--soft);
    list-style: none; }
  .drives ul li::before { content: "\\00b7 "; color: var(--warm); }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem;
    font-variant-numeric: tabular-nums; }
  th { text-align: left; font-size: 0.72rem; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--soft); font-weight: 600;
    border-bottom: 1px solid var(--rule); padding: 0.3rem 0.5rem; }
  td { padding: 0.28rem 0.5rem; border-bottom: 1px solid var(--rule); }
  td.n { text-align: right; }
  .pos { color: var(--soft); font-size: 0.78rem; }
</style>
<div class="wrap">
  <header>
    <h1>Week ${week}, ${season}</h1>
    <p class="lede">Every game played out many times over. The score and the
    box score are what happened on average; the drives are one playthrough,
    so they agree with themselves.</p>
  </header>
  ${games}
</div>`;
}

await main();

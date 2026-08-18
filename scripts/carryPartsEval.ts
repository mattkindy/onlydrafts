/**
 * Does splitting a carry predict one better than not splitting it?
 *
 * What a back makes before contact belongs to his coordinator and what
 * he makes after belongs to him, which is why the two parts carry to
 * the next season at .61 and .35 where his yards a carry carries at
 * .345. That says the parts are steadier. It does not yet say that
 * putting them back together predicts him better, which is the thing
 * the walk needs.
 *
 * Run: npx tsx scripts/carryPartsEval.ts
 */

import { spearman, rmse } from "../src/backtest/metrics.js";
import { asTeam, buildRunParts } from "../src/features/runParts.js";
import { pfrToGsis, loadRushingSeasons } from "../src/data/advancedStats.js";

const ON = [2022, 2023, 2024, 2025];

async function main(): Promise<void> {
  const toGsis = await pfrToGsis();
  const seasons = await loadRushingSeasons(20);
  const byPlayer = new Map<string, Map<number, (typeof seasons)[number]>>();

  for (const row of seasons) {
    const own = byPlayer.get(row.pfrId) ?? new Map();
    own.set(row.season, row);
    byPlayer.set(row.pfrId, own);
  }

  const guesses = new Map<string, number[]>();
  const errors = new Map<string, number[]>();
  const note = (into: Map<string, number[]>, label: string, value: number) =>
    into.set(label, [...(into.get(label) ?? []), value]);

  for (const season of ON) {
    const parts = await buildRunParts({ season });
    const truth: number[] = [];
    const ways = new Map<string, number[]>();
    const say = (label: string, value: number) =>
      ways.set(label, [...(ways.get(label) ?? []), value]);

    for (const [pfrId, own] of byPlayer) {
      const now = own.get(season);
      const was = own.get(season - 1);

      if (!now || !was || now.attempts < 60) {
        continue;
      }

      const id = toGsis.get(pfrId);
      truth.push(now.perCarry);
      say("his yards a carry last season", was.perCarry);
      say(
        "the scheme's before plus his after",
        parts.beforeFor(now.team) + (id ? parts.afterFor(id) : parts.leagueAfter),
      );
      say(
        "his own before plus his after",
        was.beforeContact + was.afterContact,
      );

      // and the same, with the before part pulled toward the league
      // when the coordinator who set it up has gone
      const stayed = parts.keptCoordinator(now.team) &&
        asTeam(was.team) === asTeam(now.team);

      for (const pull of [0.4, 0.6, 0.8]) {
        const trust = stayed ? 1 : pull;
        say(
          `before part at ${pull}, only if his coordinator went`,
          trust * was.beforeContact + (1 - trust) * parts.leagueBefore +
            was.afterContact,
        );
      }

      // the control: the same pull applied to everybody. If knowing
      // the coordinator went is worth anything, pulling only those
      // men has to beat pulling all of them the same way.
      for (const pull of [0.5, 0.7, 0.9]) {
        say(
          `before part at ${pull} for everybody`,
          pull * was.beforeContact + (1 - pull) * parts.leagueBefore +
            was.afterContact,
        );
      }
      say("the league, the same for everybody", parts.leagueBefore + parts.leagueAfter);
    }

    for (const [label, said] of ways) {
      note(guesses, label, spearman(said, truth));
      note(errors, label, rmse(said, truth));
    }

    console.log(
      `${season}: ${truth.length} backs, ` +
        `${parts.knownSides} sides kept their coordinator`,
    );
  }

  console.log(
    "\nguessing what a back makes a carry, over " + ON.join(", ") + "\n",
  );
  console.log("  how                                 ordering   error, yards");

  for (const [label, said] of guesses) {
    const mid = (values: number[]) =>
      values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    console.log(
      "  " + label.padEnd(36) + mid(said).toFixed(4).padStart(8) +
        mid(errors.get(label) ?? [0]).toFixed(3).padStart(15),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Everything needed to play out a week of football.
 *
 * The cast, who throws, how the work splits between the men, the
 * fitted play, clock and fourth down behaviour, and the sampled
 * plays themselves. The evaluation and the week report both play the
 * same games, so they build the world the same way.
 *
 * With `live` set, the world is what someone knew on the morning of
 * that week: the roster as it is, the passer from the last
 * fortnight, shares pulled toward what the season has shown, and
 * anyone ruled out of the game left at home. Without it, the world
 * is what a drafter knew in August.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import { loadWeeklyRosters } from "../data/nflverse.js";
import { fitDriveRules } from "./driveRules.js";
import { fitPasserQuality } from "./passerQuality.js";
import { loadAdp, type AdpEntry } from "../data/adp.js";
import { normalizeName } from "../data/names.js";
import { fitEndings } from "./fitEndings.js";
import {
  fitPlayFactors, countPlays, storePlays, FACTOR_DEFAULTS, type PlayRow,
} from "./fitPlayFactors.js";
import { fitFourthDown, climbTo, type FourthRow } from "./fitFourthDown.js";
import { fitPlayClock, timeBetween } from "./fitPlayClock.js";
import { fitTargetDepth } from "./targetDepth.js";
import {
  experienceBefore, pastShares, projectSplitShares, SHARING_POSITIONS,
} from "./projectedShares.js";
import { loadDraftPicks } from "../data/draftPicks.js";
import { buildMatchupTable } from "./matchupTable.js";
import { countsFor } from "./countsCache.js";
import { buildPlayerVectors } from "./playerVector.js";
import type { Side } from "../model/gameFromDrives.js";
import type { Call } from "../model/playFactors.js";

/** the fourth downs where a side actually chose, so not the flags */
const DECIDED = ["run", "pass", "field_goal", "punt"];

export interface PlayedWorld {
  sideFor: (team: string) => Side | undefined;
  rules: Awaited<ReturnType<typeof fitDriveRules>>;
  kicking: Awaited<ReturnType<typeof fitEndings>>;
  fourth: ReturnType<typeof fitFourthDown>;
  ticking: ReturnType<typeof fitPlayClock>;
  /** who throws for each side */
  throwsFor: Map<string, string>;
  /** every man on each side, by team */
  onTeam: Map<string, { playerId: string; position: string }[]>;
  /** the fitted play behaviour, for asking about single plays */
  factors: ReturnType<typeof fitPlayFactors>;
  /** every touch ever recorded, which the caller may want to score against */
  raw: ReturnType<typeof parseCsv>;
}

export async function buildWorld(
  SCORE_ON: number,
  onlyWeek: number,
  live: boolean,
  positions: Map<string, string>,
): Promise<PlayedWorld> {
  const LEARN = [SCORE_ON - 4, SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1];
  const raw = parseCsv(await readFile( 
    join(import.meta.dirname, "..", "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const learnRows = timeBetween(
    raw.filter((r) =>
      Number(r["season"]) < SCORE_ON ||
      (live && Number(r["season"]) === SCORE_ON && Number(r["week"]) < onlyWeek),
    ).map((r) => ({
      season: Number(r["season"]), week: Number(r["week"]),
      offence: r["offense"] ?? "", defence: r["defense"] ?? "",
      down: Number(r["down"]), toGo: Number(r["togo"]),
      yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
      secondsLeft: Number(r["seconds"]) || 1800,
      call: (r["playType"] ?? "") as Call,
      yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
      player: r["player"] ?? "", passer: r["passer"] ?? "",
      airYards: r["airYards"] === "" || r["airYards"] === undefined
        ? undefined : Number(r["airYards"]),
      caught: r["caught"] === "" || r["caught"] === undefined
        ? undefined : r["caught"] === "1",
    })),
  );
  const ticking = fitPlayClock(learnRows);


  /**
   * The cast comes from week one of the season being played, which a
   * drafter knows in August: who made the team, where the rookies
   * landed, who starts. Building it from last season's stats priced
   * every rookie at exactly nothing and handed Dallas to the backup
   * who mopped up while Prescott was hurt.
   */
  const castWeek = live ? onlyWeek : 1;

  /**
   * The week's injury report, which anyone setting a lineup has read.
   * A man ruled Out or Doubtful leaves the cast; a Questionable man
   * stays, since most of them play. Only the live walk reads it: in
   * August nobody knows who will be hurt in December.
   */
  const ruledOut = new Set<string>();
  const questionable = new Set<string>();

  if (live && !process.env["NO_INJURY"]) {
    for (const r of parseCsv(await readFile(
      join(import.meta.dirname, "..", "..", "data", "raw", `injuries_${SCORE_ON}.csv`),
      "utf8",
    ).catch(() => ""))) {
      if (Number(r["week"]) !== onlyWeek) {
        continue;
      }

      if (["Out", "Doubtful"].includes(r["report_status"] ?? "")) {
        ruledOut.add(r["gsis_id"] ?? "");
      }

      if (r["report_status"] === "Questionable") {
        questionable.add(r["gsis_id"] ?? "");
      }

    }
  }

  const openingWeek = (await loadWeeklyRosters(SCORE_ON))
    .filter((row) => row.week === castWeek && !ruledOut.has(row.playerId));
  const onTeam = new Map<string, { playerId: string; position: string }[]>();

  const calledOn = new Map<string, string>();

  for (const row of openingWeek) {
    const position = positions.get(row.playerId) ?? row.rawPosition;
    calledOn.set(row.playerId, row.name);

    if (!positions.has(row.playerId)) {
      positions.set(row.playerId, position);
    }

    onTeam.set(row.teamId, [
      ...(onTeam.get(row.teamId) ?? []), { playerId: row.playerId, position },
    ]);
  }

  const rules = await fitDriveRules(LEARN);
  const passerWorth = await fitPasserQuality(LEARN);
  const kicking = await fitEndings(LEARN);

  const fourths = parseCsv(await readFile(
    join(import.meta.dirname, "..", "..", "data", "curated", "fourths.csv"), "utf8",
  )).filter((r) =>
    Number(r["season"]) < SCORE_ON && Number(r["down"]) === 4 &&
    DECIDED.includes(r["playType"] ?? ""));
  const fourthSeasons = [...new Set(fourths.map((r) => Number(r["season"])))];
  const fourth = fitFourthDown(
    fourths.map((r) => ({
      toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
      margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
      choice: ["run", "pass"].includes(r["playType"] ?? "") ? "go"
        : r["playType"] === "field_goal" ? "kick" : "punt",
    })) as FourthRow[],
    60, 6, 1, climbTo(fourthSeasons, SCORE_ON),
  );

  /**
   * Each man's carries and targets, won against the men who compete
   * for that half of the work rather than for all of it at once.
   */
  const teamPlays = new Map<string, number>();

  for (const r of raw) {
    if (["run", "pass"].includes(r["playType"] ?? "")) {
      const key = `${r["season"]}|${r["offense"]}`;
      teamPlays.set(key, (teamPlays.get(key) ?? 0) + 1);
    }
  }

  const roster = [...onTeam.entries()].flatMap(([team, men]) =>
    men
      .filter((p) => SHARING_POSITIONS.includes(p.position))
      .map((p) => ({ playerId: p.playerId, position: p.position, team })),
  );
  // deterministic per season, so it is worked out once and kept
  const splitAt = join(
    import.meta.dirname, "..", "..", "data", "kept", `split-${SCORE_ON}.json`,
  );
  const splitKept = await readFile(splitAt, "utf8").catch(() => "");
  const split = splitKept
    ? new Map<string, { carries: number; targets: number }>(
        JSON.parse(splitKept) as [string, { carries: number; targets: number }][],
      )
    : projectSplitShares({
        season: SCORE_ON,
        roster,
        past: await pastShares(
          [SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1],
          (s, team) => teamPlays.get(`${s}|${team}`) ?? 1000,
        ),
        picks: await loadDraftPicks(),
        experience: await experienceBefore(SCORE_ON),
      });

  if (!splitKept && !live) {
    await writeFile(splitAt, JSON.stringify([...split.entries()]))
      .catch(() => undefined);
  }

  if (live) {
    /**
     * August's projection pulled toward what the season has shown.
     * Four weeks of evidence and the two count about equally, which
     * is where the season-to-date baseline started beating the frozen
     * walk on its own.
     */
    const soFar = new Map<string, { carries: number; targets: number }>();
    let teamWeeks = 0;
    const weeksSeen = new Set<number>();

    for (const r of raw) {
      if (Number(r["season"]) !== SCORE_ON || Number(r["week"]) >= onlyWeek) {
        continue;
      }

      weeksSeen.add(Number(r["week"]));

      if (!r["player"]) {
        continue;
      }

      const own = soFar.get(r["player"]!) ?? { carries: 0, targets: 0 };
      if (r["playType"] === "run") own.carries++;
      else own.targets++;
      soFar.set(r["player"]!, own);
    }

    teamWeeks = weeksSeen.size;
    let playsSoFar = 0;

    for (const r of raw) {
      if (
        Number(r["season"]) === SCORE_ON && Number(r["week"]) < onlyWeek &&
        ["run", "pass"].includes(r["playType"] ?? "")
      ) {
        playsSoFar++;
      }
    }

    const perWeekPlays = Math.max(30, playsSoFar / (32 * Math.max(1, teamWeeks)));
    const trust = teamWeeks / (teamWeeks + Number(process.env["TRUST_AT"] ?? 4));

    for (const [playerId, shown] of soFar) {
      const august = split.get(playerId) ?? { carries: 0, targets: 0 };
      split.set(playerId, {
        carries: trust * (shown.carries / (teamWeeks * perWeekPlays)) +
          (1 - trust) * august.carries,
        targets: trust * (shown.targets / (teamWeeks * perWeekPlays)) +
          (1 - trust) * august.targets,
      });
    }
  }

  const depth = fitTargetDepth(learnRows);
  /**
   * The pairing is a table off the disk and it short-circuits the
   * per-side gathering, which was most of the time a play took.
   */
  const pairing = await buildMatchupTable({
    learn: [SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1].filter((s2) => s2 >= 2022),
    scoreOn: SCORE_ON,
  });
  const counted = live
    ? countPlays(learnRows as PlayRow[], false)
    : await countsFor(SCORE_ON, () => learnRows as PlayRow[]);
  const factors = fitPlayFactors([], {
    ...FACTOR_DEFAULTS,
    readsTheScript: !process.env["NO_SCRIPT"],
  }, {
    split, pairing: pairing.bend, counted,
    depth: process.env["NO_DEPTH"] ? undefined : depth,
    plays: process.env["NO_SAMPLE"]
      ? undefined : storePlays(learnRows as PlayRow[]),
    alike: process.env["NO_SAMPLE"] || process.env["NO_ALIKE"]
      ? undefined
      : await (async () => {
          /**
           * Nearest men of the same position by the attribute vectors,
           * so a thin man samples from his own kind. Rookies have no
           * vector yet and stay on the pooled path.
           */
          const described = await buildPlayerVectors(SCORE_ON - 1);
          const ids = [...described.keys()];
          const nearest = new Map<string, string[]>();

          for (const id of ids) {
            const me = described.get(id)!;
            const mine = positions.get(id);
            const close = ids
              .filter((other) =>
                other !== id && positions.get(other) === mine)
              .map((other) => {
                const them = described.get(other)!.values;
                let apart = 0;

                for (let i = 0; i < me.values.length; i++) {
                  apart += (me.values[i]! - them[i]!) ** 2;
                }

                return { other, apart };
              })
              .sort((a, b) => a.apart - b.apart)
              .slice(0, 8)
              .map((x) => x.other);
            nearest.set(id, close);
          }

          return nearest;
        })(),
  });

  if (process.env["NO_MATCHUP"]) {
    delete factors.matchup;
  }

  /**
   * Who throws for each side. It used to be whoever took the throws in
   * the opening fortnight of the season being played, which is a
   * fortnight of leak. An August drafter knows the starter because the
   * market prices him, so the starter is now the quarterback on the
   * roster the market takes earliest, and the one who threw most last
   * season where the market has not priced any of them.
   */
  const augustAdp = await loadAdp(SCORE_ON).catch(() => new Map<string, AdpEntry>());
  const threwLastYear = new Map<string, number>();

  for (const r of raw) {
    if (Number(r["season"]) !== SCORE_ON - 1 || r["playType"] !== "pass" ||
        !r["passer"]) {
      continue;
    }

    threwLastYear.set(
      r["passer"]!, (threwLastYear.get(r["passer"]!) ?? 0) + 1,
    );
  }

  const throwsFor = new Map<string, string>();

  for (const [team, men] of onTeam) {
    const quarterbacks = men.filter((p) => p.position === "QB");
    const priced = quarterbacks
      .map((p) => ({
        playerId: p.playerId,
        adp: augustAdp.get(
          `${normalizeName(calledOn.get(p.playerId) ?? "")}|QB`,
        )?.adp,
      }))
      .filter((p): p is { playerId: string; adp: number } => p.adp !== undefined)
      .sort((a, b) => a.adp - b.adp);

    if (priced.length > 0) {
      throwsFor.set(team, priced[0]!.playerId);
      continue;
    }

    const threw = quarterbacks
      .map((p) => ({ playerId: p.playerId, n: threwLastYear.get(p.playerId) ?? 0 }))
      .sort((a, b) => b.n - a.n);

    if (threw.length > 0 && threw[0]!.n > 0) {
      throwsFor.set(team, threw[0]!.playerId);
    }
  }

  /**
   * A quarterback runs too, and his share of the carries is his own
   * habit rather than a competition: nobody else scrambles for him.
   * Half of what the running quarterbacks score is on the ground, and
   * without this the walk projects them as statues.
   */
  const qbCarries = new Map<string, number>();
  const qbSeasons = [SCORE_ON - 2, SCORE_ON - 1];
  const carried = new Map<string, number>();

  for (const r of raw) {
    const season = Number(r["season"]);

    if (!qbSeasons.includes(season)) {
      continue;
    }

    if (r["playType"] === "run" && r["player"] &&
        positions.get(r["player"]!) === "QB") {
      carried.set(r["player"]!, (carried.get(r["player"]!) ?? 0) + 1);
    }

  }

  const everyQbCarry = [...carried.values()].reduce((a, b) => a + b, 0);
  const everyPlay = qbSeasons.reduce(
    (sum, season) =>
      sum + [...teamPlays.entries()]
        .filter(([key]) => key.startsWith(`${season}|`))
        .reduce((s2, [, n]) => s2 + n, 0),
    0,
  );
  const leagueQb = everyPlay > 0 ? everyQbCarry / everyPlay : 0.05;

  for (const [team, passer] of throwsFor) {

    if (!passer) {
      continue;
    }

    const ran = carried.get(passer) ?? 0;
    const plays = qbSeasons.reduce(
      (sum, season) => sum + (teamPlays.get(`${season}|${team}`) ?? 0), 0,
    );

    if (plays <= 0) {
      qbCarries.set(passer, leagueQb);
      continue;
    }

    // his own habit, pulled toward the league until he has run enough
    const trust = ran / (ran + 30);
    qbCarries.set(passer, trust * (ran / plays) + (1 - trust) * leagueQb);
  }

  for (const [passer, share] of qbCarries) {
    split.set(passer, { carries: share, targets: 0 });
  }

  /**
   * A man listed questionable gets less of the work, and his
   * teammates take the rest.
   *
   * Over 2025, a questionable skill player took the field 57% of the
   * time, and when he did he saw 94% of the touches he usually sees,
   * so about half an afternoon in expectation. Giving him a whole one
   * both overstated him and starved whoever actually covers for him.
   */
  const stillPlays = Number(process.env["QUESTIONABLE_AT"] ?? 0.54);

  for (const playerId of questionable) {
    const his = split.get(playerId);

    if (his) {
      split.set(playerId, {
        carries: his.carries * stillPlays,
        targets: his.targets * stillPlays,
      });
    }
  }

  const sideFor = (team: string): Side | undefined => {
    const men = onTeam.get(team);

    if (!men) {
      return undefined;
    }

    const passer = throwsFor.get(team);
    /**
     * Only the men who would see the field. The whole roster put 27
     * skill players in the cast where a side dresses about 11, and a
     * fifth of the walk's throws went to men nobody throws to, drawn
     * from the pooled fallback that gains 4.62 where a targeted throw
     * gains 7.33. The projected shares already say who plays, rookies
     * included, so the cast is the twelve largest of them.
     */
    const skill = men
      .filter((p) => SHARING_POSITIONS.includes(p.position))
      .map((p) => ({
        playerId: p.playerId,
        share: (() => {
          const his = split.get(p.playerId);

          return his ? his.carries + his.targets : 0;
        })(),
      }))
      .sort((a, b) => b.share - a.share);
    const anyShare = skill.some((p) => p.share > 0);
    const cast = anyShare ? skill.slice(0, 12) : skill;

    return {
      team, factors, passer,
      passLift: passer ? passerWorth(passer) : 1,
      among: [
        ...cast.map((p) => p.playerId),
        ...(passer ? [passer] : []),
      ],
    };
  };
  return {
    sideFor, rules, kicking, fourth, ticking, throwsFor, onTeam,
    factors, raw,
  };
}

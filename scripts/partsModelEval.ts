/**
 * Does predicting yards and catches beat predicting points?
 *
 * The season regression is fitted on fantasy points, so it has to be
 * told a league's rules before it says anything. Predicting the parts
 * of a stat line instead lets whoever reads it apply their own. That
 * is only worth doing if the parts, once scored, order players about
 * as well as the points model does, which is what this asks. It scores
 * both under standard and under ppr, since the whole point is serving
 * more than one league.
 *
 * Run: npx tsx scripts/partsModelEval.ts
 */

import { spearman } from "../src/backtest/metrics.js";
import { setScoring } from "../src/scoring/active.js";
import { presets, fantasyPoints } from "../src/scoring/fantasyPoints.js";
import { PART_NAMES } from "../src/features/seasonSummary.js";
import {
  buildSeasonData, examplesForTransition, fitSeasonModel,
  predictSeasonBlend, type SeasonExample,
} from "../src/features/seasonModel.js";
import {
  fitPartsModel, predictParts, partsByPosition,
} from "../src/features/partsModel.js";

const ALL = [
  2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
];
const TRAIN_FROM = 2017;
const TEST = [2022, 2023, 2024, 2025];

const scoreParts = (
  parts: Record<string, number>, rules: typeof presets.standard,
) => fantasyPoints({
  passYds: parts["passYds"] ?? 0, passTd: parts["passTd"] ?? 0,
  interceptions: parts["interceptions"] ?? 0,
  rushYds: parts["rushYds"] ?? 0, rushTd: parts["rushTd"] ?? 0,
  receptions: parts["receptions"] ?? 0, recYds: parts["recYds"] ?? 0,
  recTd: parts["recTd"] ?? 0, fumblesLost: 0, twoPointConversions: 0,
}, rules);

async function main(): Promise<void> {
  const data = await buildSeasonData(ALL);
  const rows: {
    season: number; named: string; men: number;
    points: number; parts: number; adp: number;
    topPoints: number; topParts: number; topAdp: number;
  }[] = [];

  for (const named of ["standard", "ppr"] as const) {
    const rules = presets[named];
    setScoring(rules);

    for (const season of TEST) {
      const train: SeasonExample[] = [];

      for (const t of ALL.filter((s) => s >= TRAIN_FROM && s < season)) {
        train.push(...(await examplesForTransition(t, data)));
      }

      const test = await examplesForTransition(season, data);
      const pointsFit = fitSeasonModel(train);
      const partsFit = fitPartsModel(train);
      const floors = partsByPosition(train);
      // scored the same way for both, so only the prediction differs
      const truth = test.map((e) => scoreParts({ ...e.actualParts }, rules));

      const saidPoints = test.map((e) => predictSeasonBlend(pointsFit, e));
      const saidParts = test.map((e) => scoreParts(
        { ...predictParts(partsFit, e, floors) }, rules,
      ));
      /**
       * And the same over the men a draft actually argues about.
       * Pooled over everybody, telling a starter from a third stringer
       * is easy and flatters both models.
       */
      const top = [...test.keys()]
        .filter((i) => test[i]!.adp !== undefined)
        .sort((a, b) => (test[a]!.adp ?? 250) - (test[b]!.adp ?? 250))
        .slice(0, 40);
      const cut = (said: number[]) =>
        spearman(top.map((i) => said[i]!), top.map((i) => truth[i]!));

      /**
       * And where the room had them, on the same men. Anyone the
       * market never priced keeps a place past the end of it, since
       * going undrafted is itself an opinion.
       */
      const saidAdp = test.map((e) => -(e.adp ?? 250));

      rows.push({
        season, named, men: test.length,
        points: spearman(saidPoints, truth),
        parts: spearman(saidParts, truth),
        adp: spearman(saidAdp, truth),
        topPoints: cut(saidPoints),
        topParts: cut(saidParts),
        topAdp: cut(saidAdp),
      });
    }
  }

  console.log("ordering a season's points, the parts model against the points one");
  console.log("                     everybody          the 40 taken earliest");
  console.log("scoring    season   points  parts    adp     points  parts    adp");

  for (const r of rows) {
    console.log(
      `${r.named.padEnd(10)} ${r.season}    ` +
        `${r.points.toFixed(3)}  ${r.parts.toFixed(3)}  ${r.adp.toFixed(3)}   ` +
        `${r.topPoints.toFixed(3)}  ${r.topParts.toFixed(3)}  ${r.topAdp.toFixed(3)}`,
    );
  }

  for (const named of ["standard", "ppr"]) {
    const mine = rows.filter((r) => r.named === named);
    const mean = (of: (r: typeof rows[number]) => number) =>
      mine.reduce((s, r) => s + of(r), 0) / mine.length;
    console.log(
      `${named.padEnd(10)} average  ${mean((r) => r.points).toFixed(3)}  ` +
        `${mean((r) => r.parts).toFixed(3)}  ${mean((r) => r.adp).toFixed(3)}   ` +
        `${mean((r) => r.topPoints).toFixed(3)}  ` +
        `${mean((r) => r.topParts).toFixed(3)}  ` +
        `${mean((r) => r.topAdp).toFixed(3)}`,
    );
  }

  console.log(`\nparts fitted: ${PART_NAMES.join(", ")}`);
}

await main();

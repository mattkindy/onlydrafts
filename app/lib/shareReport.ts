/**
 * The week in review as one tall PNG, next to the week of cards.
 *
 * The ground, the header, and the footer come from the share image, so a
 * report pasted into the chat is recognisably from the same app. Rows go
 * two to a line and each one is four short pieces, because the phone that
 * reads it in the chat is about four hundred points wide. The little bars
 * are worked out here rather than in the canvas, so the card on the page
 * and the picture put them in the same place.
 */

import {
  fitted, FONT, PAD, HEAD, FOOT, roundRect, sharePicture, SHADES,
  SITE, WIDTH, type Picture,
} from "./shareImage.ts";
import { scoredSays } from "./scoring.ts";
import type { Spread } from "./spread.ts";
import {
  AWARD_SAYS, quantileSays,
  type Award, type PlayerNote, type Report, type Scorer, type SideScore,
} from "./weekReport.ts";

/** green for a good week, red for a bad one, plain for the rest */
export type Tone = "up" | "down" | "flat";

/** every mark on a spread bar, as a share of the bar's width */
export interface SpreadBar {
  q1: number;
  q3: number;
  mid: number;
  /** where his points landed, which is the dot */
  at: number;
  /** and whether they landed outside the spread altogether */
  beyond: boolean;
}

/**
 * His floor to his ceiling across the whole bar, with the middle half and
 * the median marked, and his points as a dot. A week outside the spread
 * stretches the bar rather than running off the end of it.
 */
export function spreadBarOf(spread: Spread, points: number): SpreadBar {
  const low = Math.min(spread.low, points);
  const high = Math.max(spread.high, points);
  const span = Math.max(high - low, 0.01);
  const share = (n: number) => (n - low) / span;

  return {
    q1: share(spread.q1),
    q3: share(spread.q3),
    mid: share(spread.mid),
    at: share(points),
    beyond: points < spread.low || points > spread.high,
  };
}

/** what one row draws beside its figures, where a picture says anything */
export type RowChart =
  | { kind: "spread"; bar: SpreadBar }
  | { kind: "fill"; fill: number; won: boolean | null };

export interface ReportRow {
  /** what the row is for, above the name */
  label: string;
  /** whose row it is */
  head: string;
  /** the number, against the right hand edge of its column */
  figure: string;
  /** the short line underneath */
  foot: string;
  tone: Tone;
  chart?: RowChart;
}

/** one team's bar on the scores strip */
export interface ScoreBar extends SideScore {
  /** its points as a share of the biggest week, and the same for its best */
  fill: number;
  most: number;
}

export interface ScoresBlock {
  kind: "scores";
  title: string;
  bars: ScoreBar[];
  /** the middle of the week, as a share of the widest bar */
  median: number;
  /** and what that middle was */
  middle: string;
  y: number;
  height: number;
}

export interface RowsBlock {
  kind: "rows";
  title: string;
  rows: ReportRow[];
  /** how tall one line of rows is here, since a chart needs more */
  line: number;
  y: number;
  height: number;
}

export type ReportBlock = RowsBlock | ScoresBlock;

export interface ReportLayout extends Picture {
  /** said when the week is not over yet */
  note: string | null;
  blocks: ReportBlock[];
}

const GAP = 24;
const BLOCK_TITLE = 46;
const ROW = 92;
const CHART_ROW = 124;
const BLOCK_PAD = 20;
const STRIP_ROW = 46;

/** a green award is one you would want, a red one is not */
const AWARD_TONE: Record<Award, Tone> = {
  highest: "up",
  lowest: "down",
  blowout: "up",
  closest: "flat",
  lucky: "flat",
  unlucky: "down",
  stolen: "up",
  choke: "down",
  beater: "up",
  shortfall: "down",
  bench: "down",
  manager: "up",
  swap: "down",
};

const spreadChart = (note: PlayerNote): RowChart =>
  ({ kind: "spread", bar: spreadBarOf(note.spread, note.points) });

const noteRow = (label: string, note: PlayerNote, tone: Tone): ReportRow => ({
  label,
  head: note.name,
  figure: scoredSays(note.points),
  foot: `${note.owner}, line ${note.line.toFixed(1)}, ` +
    quantileSays(note.quantile),
  tone,
  chart: spreadChart(note),
});

const scorerRow = (label: string, his: Scorer, tone: Tone): ReportRow => ({
  label,
  head: his.name,
  figure: scoredSays(his.points),
  foot: his.owner,
  tone,
});

function rowsBlock(title: string, rows: ReportRow[], y: number): RowsBlock {
  const line = rows.some((row) => row.chart) ? CHART_ROW : ROW;

  return {
    kind: "rows",
    title,
    rows,
    line,
    y,
    height: BLOCK_TITLE + Math.ceil(rows.length / 2) * line + BLOCK_PAD,
  };
}

function scoresBlock(report: Report, y: number): ScoresBlock {
  const most = Math.max(...report.scores.map((s) => Math.max(s.points, s.best)));
  const share = (n: number) => (most > 0 ? n / most : 0);

  return {
    kind: "scores",
    title: "scores",
    bars: report.scores.map((side) => ({
      ...side,
      fill: share(side.points),
      most: share(side.best),
    })),
    median: share(report.median),
    middle: scoredSays(report.median),
    y,
    height: BLOCK_TITLE + report.scores.length * STRIP_ROW + BLOCK_PAD,
  };
}

const positionRows = (report: Report): ReportRow[] =>
  report.positions.flatMap((pick) => [
    ...(pick.over ? [noteRow(pick.position + " best", pick.over, "up")] : []),
    ...(pick.under
      ? [noteRow(pick.position + " worst", pick.under, "down")]
      : []),
  ]);

const awardRows = (report: Report): ReportRow[] =>
  report.awards
    // the manager of the week is already at the top of the report
    .filter((given) => given !== report.manager)
    .map((given) => ({
      label: AWARD_SAYS[given.award],
      head: given.owner,
      figure: given.figure,
      foot: given.note ?? "",
      tone: AWARD_TONE[given.award],
      ...(given.fill === undefined
        ? {}
        : {
          chart: {
            kind: "fill", fill: given.fill, won: given.won ?? null,
          } as RowChart,
        }),
    }));

const zeroRows = (report: Report): ReportRow[] =>
  report.zeroes.map((its) => ({
    label: its.owner,
    head: its.names.join(", "),
    // a count only says anything when a manager started more than one
    figure: its.names.length > 1 ? String(its.names.length) : "",
    foot: "",
    tone: "down" as Tone,
  }));

const stackRows = (report: Report): ReportRow[] =>
  report.stack
    ? [{
      label: report.stack.team + " stack",
      head: report.stack.names[0],
      figure: scoredSays(report.stack.points),
      foot: `with ${report.stack.names[1]}, ${report.stack.owner}`,
      tone: "up" as Tone,
    }]
    : [];

const freeAgentRows = (report: Report): ReportRow[] => {
  const free = report.freeAgents;

  if (!free?.top) {
    return [];
  }

  const rest = free.positions
    .filter((its) => its.top && its.top.key !== free.top?.key)
    .map((its) => scorerRow(its.position, its.top!, "flat"));

  return [scorerRow("top free agent", free.top, "up"), ...rest];
};

const leadRows = (report: Report): ReportRow[] => [
  ...(report.player
    ? [noteRow("player of the week", report.player, "up")]
    : []),
  ...(report.manager
    ? [{
      label: "manager of the week",
      head: report.manager.owner,
      figure: report.manager.figure,
      foot: report.manager.note ?? "",
      tone: "up" as Tone,
    }]
    : []),
];

/** how much of the week is in, for one somebody is still playing */
const noteFor = (report: Report) =>
  report.provisional
    ? `${report.finished} of ${report.games} games final, numbers will move`
    : null;

export function layoutReport(report: Report): ReportLayout {
  const note = noteFor(report);
  let y = HEAD + (note ? 34 : 0);
  const blocks: ReportBlock[] = [];
  const put = (block: ReportBlock) => {
    blocks.push(block);
    y += block.height + GAP;
  };
  const rows = (title: string, its: ReportRow[]) => {
    if (!its.length) {
      return;
    }

    put(rowsBlock(title, its, y));
  };

  rows("headliners", leadRows(report));

  if (report.scores.length) {
    put(scoresBlock(report, y));
  }

  rows("awards", awardRows(report));
  rows("best and worst by position", positionRows(report));
  rows(
    "best on the bench",
    report.benched.map((his) => scorerRow(his.position, his, "flat")),
  );
  rows("goose eggs", zeroRows(report));
  rows("best stack", stackRows(report));
  rows("best free agents", freeAgentRows(report));

  return {
    width: WIDTH,
    height: y - (blocks.length ? GAP : 0) + FOOT,
    title: report.league,
    subtitle: `week ${report.week} recap`,
    footer: SITE,
    note,
    blocks,
  };
}

/** every word the picture shows, in reading order, for tests */
export function reportTextOf(layout: ReportLayout): string[] {
  const words = [layout.title, layout.subtitle];

  if (layout.note) {
    words.push(layout.note);
  }

  for (const block of layout.blocks) {
    words.push(block.title);

    if (block.kind === "scores") {
      words.push(...block.bars.flatMap(
        (bar) => [bar.owner, scoredSays(bar.points)]));
      words.push("median " + block.middle);

      continue;
    }

    for (const row of block.rows) {
      words.push(row.label, row.head, row.figure, row.foot);
    }
  }

  words.push(layout.footer);

  return words;
}

const TONES: Record<Tone, string> = {
  up: SHADES.go,
  down: SHADES.no,
  flat: SHADES.ink,
};

const BAR = 12;
const DOT = 9;

/** the middle half of a spread, the page's green over its chip, mixed */
const MIDDLE = "#2A674E";

function drawSpread(
  ctx: CanvasRenderingContext2D, bar: SpreadBar,
  left: number, width: number, top: number,
) {
  // the dot is kept clear of the ends, so a week outside the spread is
  // still a dot on the bar rather than half of one past it
  const at = (share: number) => left + DOT + share * (width - DOT * 2);

  ctx.fillStyle = SHADES.chip;
  roundRect(ctx, left, top, width, BAR, BAR / 2);
  ctx.fill();

  ctx.fillStyle = MIDDLE;
  ctx.fillRect(at(bar.q1), top, Math.max(2, at(bar.q3) - at(bar.q1)), BAR);

  ctx.fillStyle = SHADES.faint;
  ctx.fillRect(at(bar.mid) - 1, top - 3, 3, BAR + 6);

  ctx.beginPath();
  ctx.arc(at(bar.at), top + BAR / 2, DOT, 0, Math.PI * 2);
  ctx.fillStyle = bar.beyond ? SHADES.mark : SHADES.ink;
  ctx.fill();
}

function drawFill(
  ctx: CanvasRenderingContext2D, chart: { fill: number; won: boolean | null },
  left: number, width: number, top: number,
) {
  ctx.fillStyle = SHADES.chip;
  roundRect(ctx, left, top, width, BAR, BAR / 2);
  ctx.fill();

  ctx.fillStyle = chart.won === false ? SHADES.no : SHADES.go;
  roundRect(
    ctx, left, top,
    Math.max(4, Math.min(1, Math.max(0, chart.fill)) * width), BAR, BAR / 2);
  ctx.fill();

  if (chart.won === null) {
    return;
  }

  // the tick says who actually won it, which is the whole point of the bar
  ctx.fillStyle = SHADES.ink;
  ctx.fillRect(chart.won ? left + width - 4 : left, top - 4, 4, BAR + 8);
}

const CHARTS: Record<
  RowChart["kind"],
  (
    ctx: CanvasRenderingContext2D, chart: RowChart,
    left: number, width: number, top: number,
  ) => void
> = {
  spread: (ctx, chart, left, width, top) => {
    if (chart.kind === "spread") {
      drawSpread(ctx, chart.bar, left, width, top);
    }
  },
  fill: (ctx, chart, left, width, top) => {
    if (chart.kind === "fill") {
      drawFill(ctx, chart, left, width, top);
    }
  },
};

function drawRow(
  ctx: CanvasRenderingContext2D, row: ReportRow,
  left: number, width: number, top: number,
) {
  const right = left + width;

  ctx.textAlign = "left";
  ctx.fillStyle = SHADES.faint;
  ctx.font = "700 21px " + FONT;
  ctx.fillText(fitted(ctx, row.label, width), left, top + 21);

  ctx.fillStyle = SHADES.ink;
  ctx.font = "700 29px " + FONT;

  const figure = ctx.measureText(row.figure).width;

  ctx.fillText(fitted(ctx, row.head, width - figure - 18), left, top + 54);

  ctx.textAlign = "right";
  ctx.fillStyle = TONES[row.tone];
  ctx.font = "800 29px " + FONT;
  ctx.fillText(row.figure, right, top + 54);

  ctx.textAlign = "left";
  ctx.fillStyle = SHADES.muted;
  ctx.font = "500 21px " + FONT;
  ctx.fillText(fitted(ctx, row.foot, width), left, top + 80);

  if (row.chart) {
    CHARTS[row.chart.kind](ctx, row.chart, left, width, top + 94);
  }
}

function drawScores(ctx: CanvasRenderingContext2D, block: ScoresBlock) {
  const left = PAD + BLOCK_PAD;
  const width = WIDTH - PAD * 2 - BLOCK_PAD * 2;
  const named = 250;
  const figures = 130;
  const bars = width - named - figures;

  block.bars.forEach((bar, at) => {
    const top = block.y + BLOCK_TITLE + at * STRIP_ROW;

    ctx.textAlign = "left";
    ctx.fillStyle = SHADES.ink;
    ctx.font = "700 25px " + FONT;
    ctx.fillText(fitted(ctx, bar.owner, named - 16), left, top + 26);

    const barLeft = left + named;

    ctx.fillStyle = SHADES.chip;
    roundRect(ctx, barLeft, top + 10, bars, BAR, BAR / 2);
    ctx.fill();

    // the paler end is what his bench would have added
    ctx.fillStyle = SHADES.edge;
    roundRect(ctx, barLeft, top + 10, Math.max(4, bar.most * bars), BAR, BAR / 2);
    ctx.fill();

    ctx.fillStyle = bar.won ? SHADES.go : SHADES.muted;
    roundRect(ctx, barLeft, top + 10, Math.max(4, bar.fill * bars), BAR, BAR / 2);
    ctx.fill();

    ctx.fillStyle = SHADES.mark;
    ctx.fillRect(barLeft + block.median * bars - 1, top + 5, 3, BAR + 10);

    ctx.textAlign = "right";
    ctx.fillStyle = SHADES.ink;
    ctx.font = "700 25px " + FONT;
    ctx.fillText(scoredSays(bar.points), left + width, top + 26);
  });
}

export function paintReport(
  ctx: CanvasRenderingContext2D, layout: ReportLayout,
) {
  if (layout.note) {
    ctx.textAlign = "left";
    ctx.fillStyle = SHADES.mark;
    ctx.font = "600 24px " + FONT;
    ctx.fillText(layout.note, PAD, HEAD - 24);
  }

  const width = layout.width - PAD * 2;
  const column = (width - BLOCK_PAD * 2 - GAP) / 2;

  for (const block of layout.blocks) {
    ctx.fillStyle = SHADES.panel;
    roundRect(ctx, PAD, block.y, width, block.height, 18);
    ctx.fill();
    ctx.strokeStyle = SHADES.edge;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.fillStyle = SHADES.muted;
    ctx.font = "800 26px " + FONT;
    ctx.fillText(block.title, PAD + BLOCK_PAD, block.y + 34);

    if (block.kind === "scores") {
      drawScores(ctx, block);

      continue;
    }

    block.rows.forEach((row, at) => {
      const side = at % 2;
      const left = PAD + BLOCK_PAD + side * (column + GAP);
      const top = block.y + BLOCK_TITLE + Math.floor(at / 2) * block.line;

      drawRow(ctx, row, left, column, top);
    });
  }
}

export const shareReport = (layout: ReportLayout) =>
  sharePicture(layout, paintReport);

/**
 * The week in review, under the week's games, and the same picture the
 * share button sends to the chat.
 *
 * The card draws the blocks the share layout works out, so the page and
 * the picture cannot drift into saying different things. Every small bar
 * is a share of its row, in the page's own colours, so both themes work.
 */

import { useMemo } from "preact/hooks";

import {
  layoutReport, shareReport,
  type ReportRow, type RowChart, type ScoresBlock,
} from "../lib/shareReport.ts";
import { scoredSays } from "../lib/scoring.ts";
import type { Report } from "../lib/weekReport.ts";
import { ShareButton } from "./ShareButton.tsx";

const pct = (share: number) =>
  Math.min(100, Math.max(0, share * 100)) + "%";

/** the same share, kept clear of the ends so the dot stays on the bar */
const inset = (share: number) =>
  `calc(7px + (100% - 14px) * ${Math.min(1, Math.max(0, share)).toFixed(4)})`;

/** his floor to his ceiling, the middle half darker, his week as a dot */
function Range({ chart }: { chart: RowChart }) {
  if (chart.kind !== "spread") {
    return null;
  }

  const { bar } = chart;

  return (
    <span class="rng" aria-hidden="true">
      <u style={{ left: pct(bar.q1), right: pct(1 - bar.q3) }} />
      <b style={{ left: inset(bar.mid) }} />
      <i class={bar.beyond ? "out" : ""} style={{ left: inset(bar.at) }} />
    </span>
  );
}

/**
 * Every week he could have had, with the part past the week he did have
 * filled in. That filled sliver is the odds the line above says in
 * words, so it is drawn over the rest rather than beside it.
 */
function Bell({ chart }: { chart: RowChart }) {
  if (chart.kind !== "curve") {
    return null;
  }

  const { curve } = chart;
  const across = (share: number) => (share * 100).toFixed(2);
  const up = (share: number) => (100 - share * 96).toFixed(2);
  const outline = curve.line
    .map(([x, y]) => `${across(x)},${up(y)}`)
    .join(" ");
  const shape = `M0,100 L${outline} L100,100 Z`;
  const at = across(curve.at);
  const tail = curve.high
    ? `M${at},0 H100 V100 H${at} Z`
    : `M0,0 H${at} V100 H0 Z`;

  return (
    <svg
      class="bell" viewBox="0 0 100 100" preserveAspectRatio="none"
      aria-hidden="true"
    >
      <clipPath id="past"><path d={tail} /></clipPath>
      <path class="all" d={shape} />
      <path
        class={curve.high ? "past up" : "past down"} d={shape}
        clip-path="url(#past)"
      />
      <path class="edge" d={`M${outline}`} />
      <path class="line" d={`M${across(curve.mid)},18 V100`} />
      <path
        class={curve.high ? "mark up" : "mark down"} d={`M${at},0 V100`}
      />
    </svg>
  );
}

/** a chance, with a tick at the end for the side that actually won */
function Fill({ chart }: { chart: RowChart }) {
  if (chart.kind !== "fill") {
    return null;
  }

  return (
    <span class="fillbar" aria-hidden="true">
      <u
        class={chart.won === false ? "no" : ""}
        style={{ width: pct(chart.fill) }}
      />
      {chart.won !== null && <b class={chart.won ? "right" : "left"} />}
    </span>
  );
}

const CHARTS: Record<RowChart["kind"], typeof Range> = {
  spread: Range,
  curve: Bell,
  fill: Fill,
};

function Row({ row }: { row: ReportRow }) {
  const Chart = row.chart ? CHARTS[row.chart.kind] : null;

  return (
    <div class={row.chart?.kind === "curve" ? "rev hero" : "rev"}>
      <span class="lab">{row.label}</span>
      <span class="who">{row.head}</span>
      <span class={"fig " + row.tone}>{row.figure}</span>
      {row.foot && <span class="ft">{row.foot}</span>}
      {Chart && row.chart && <Chart chart={row.chart} />}
    </div>
  );
}

/** every score in the league, biggest first, with the week's middle marked */
function Strip({ block }: { block: ScoresBlock }) {
  return (
    <div class="strip">
      {block.bars.map((bar) => (
        <div class="score" key={bar.owner}>
          <span class="nm">{bar.owner}</span>
          <span class="bar">
            <u class="best" style={{ width: pct(bar.most) }} />
            <u
              class={bar.won ? "won" : "lost"}
              style={{ width: pct(bar.fill) }}
            />
            <b style={{ left: pct(block.median) }} />
          </span>
          <span class="pts">{scoredSays(bar.points)}</span>
        </div>
      ))}
      <p class="hint">
        Green won, grey lost. Pale part is points left on the bench.
        Line is the league median, {block.middle}.
      </p>
    </div>
  );
}

export function WeekReport({ report }: { report: Report }) {
  const layout = useMemo(() => layoutReport(report), [report]);

  if (!layout.blocks.length) {
    return null;
  }

  return (
    <div class="card plain review">
      <div class="revtop">
        <h3>week {report.week} recap</h3>
        <ShareButton
          label="share"
          onShare={() => shareReport(layout)}
        />
      </div>

      {layout.note && <p class="hint warn">{layout.note}</p>}

      {layout.blocks.map((block) => (
        <section class="revblock" key={block.title}>
          <h4>{block.title}</h4>
          {block.kind === "scores"
            ? <Strip block={block} />
            : (
              <div class={block.wide ? "revrows wide" : "revrows"}>
                {block.rows.map((row, at) => (
                  <Row row={row} key={row.label + row.head + at} />
                ))}
              </div>
            )}
        </section>
      ))}
    </div>
  );
}

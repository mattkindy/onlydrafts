/**
 * The stats tab as pictures for the league chat: everybody's playoff
 * chances, and the season table.
 *
 * Both are tables, so both lay out as rows under the header every share
 * picture has. The words and the row positions are worked out here
 * where there is no canvas, so a test can read them; painting them is
 * the only part that needs one.
 */

import {
  FONT, fitted, FOOT, HEAD, PAD, roundRect, SHADES, sharePicture, SITE, WIDTH,
  type Picture,
} from "./shareImage.ts";

/** how tall one team's row is, and the gap a column header takes */
const ROW = 76;
const COLUMNS = 52;

export interface OddsRowText {
  y: number;
  name: string;
  record: string;
  wins: string;
  odds: string;
  /** how often it sits out the first round and wins it all, where the page says */
  bye: string | null;
  title: string | null;
  /** its chance of winning its division, where the league has them */
  division: string | null;
  /** how much of the bar the chance fills, 0 to 1 */
  fill: number;
  mine: boolean;
}

export interface PlayoffPicture extends Picture {
  rows: OddsRowText[];
  /** where the line under the last playoff place is drawn, if there is one */
  cut: number | null;
  /** whether the bye and title columns are drawn, as the page draws them */
  hasBye: boolean;
  hasTitle: boolean;
}

/** a share as a whole percentage, with tenths at the very ends */
function pctText(share: number): string {
  const percent = share * 100;

  if (percent > 99 && percent < 100) {
    return (Math.floor(percent * 10) / 10).toFixed(1) + "%";
  }

  if (percent > 0 && percent < 1) {
    return (Math.ceil(percent * 10) / 10).toFixed(1) + "%";
  }

  return percent.toFixed(0) + "%";
}

export function layoutPlayoffs(input: {
  league: string;
  week: number;
  playoffTeams: number;
  /** who gets in, in a line, where it is more than the top so many */
  rule?: string;
  /** what you have picked or nudged, so a what-if is never taken for the real odds */
  whatIf?: string;
  teams: {
    name: string; record: string; wins: number; odds: number; mine: boolean;
    bye?: number | undefined; champion?: number | undefined; division?: number | undefined;
  }[];
}): PlayoffPicture {
  const top = HEAD + COLUMNS;
  const hasTitle = input.teams.some((t) => t.champion !== undefined);
  const hasBye = hasTitle && input.teams.some((t) => t.bye !== undefined);
  const rows = [...input.teams]
    .sort((a, b) => b.odds - a.odds || b.wins - a.wins)
    .map((team, at): OddsRowText => ({
      y: top + at * ROW,
      name: team.name,
      record: team.record,
      wins: team.wins.toFixed(1),
      odds: pctText(team.odds),
      bye: hasBye ? pctText(team.bye ?? 0) : null,
      title: hasTitle ? pctText(team.champion ?? 0) : null,
      division: team.division === undefined ? null : pctText(team.division),
      fill: Math.min(1, Math.max(0, team.odds)),
      mine: team.mine,
    }));
  const cut = input.playoffTeams > 0 && input.playoffTeams < rows.length
    ? top + input.playoffTeams * ROW
    : null;

  return {
    width: WIDTH,
    height: top + rows.length * ROW + FOOT + PAD,
    title: input.league,
    subtitle: input.whatIf
      ? `what if ${input.whatIf}, week ${input.week}`
      : `playoff chances, week ${input.week}`,
    footer: `${SITE} · ${input.rule ?? `top ${input.playoffTeams} make it`} · 5,000 seasons simulated`,
    rows,
    cut,
    hasBye,
    hasTitle,
  };
}

/**
 * The column headings and the rows, painted under the header. With the
 * bracket played out the picture reads as the page does: the record and
 * projected wins under the name, and the playoffs, the bye and the title
 * side by side at the right; without it, a bar for the one chance there is.
 */
export function paintPlayoffs(ctx: CanvasRenderingContext2D, layout: PlayoffPicture) {
  const left = PAD + 24;
  const right = layout.width - PAD - 24;
  const columns = [
    "PLAYOFFS", ...(layout.hasBye ? ["BYE"] : []), ...(layout.hasTitle ? ["TITLE"] : []),
  ];
  // each odds column's right edge, the last at the right of the picture
  const colAt = columns.map((_, i) => right - (columns.length - 1 - i) * 150);
  const stacked = layout.hasTitle;
  const barLeft = stacked ? 430 : 640;
  const barRight = stacked ? colAt[0]! - 140 : right - 130;

  ctx.fillStyle = SHADES.faint;
  ctx.font = "700 20px " + FONT;
  ctx.textAlign = "left";
  ctx.fillText("TEAM", left, HEAD + 24);
  ctx.textAlign = "right";

  if (!stacked) {
    ctx.fillText("RECORD", 470, HEAD + 24);
    ctx.fillText("PROJ W", 590, HEAD + 24);
  }

  columns.forEach((head, i) => ctx.fillText(head, colAt[i]!, HEAD + 24));

  for (const row of layout.rows) {
    if (row.mine) {
      ctx.fillStyle = SHADES.panel;
      roundRect(ctx, PAD, row.y, layout.width - PAD * 2, ROW - 8, 14);
      ctx.fill();
    }

    // one baseline for the name and every figure, the line under it below
    const mid = stacked ? row.y + 36 : row.y + ROW / 2 + 6;

    ctx.textAlign = "left";
    ctx.fillStyle = SHADES.ink;
    ctx.font = (row.mine ? "800 " : "600 ") + "30px " + FONT;
    ctx.fillText(fitted(ctx, row.name, 330), left, mid);

    if (stacked) {
      ctx.fillStyle = SHADES.muted;
      ctx.font = "600 22px " + FONT;
      ctx.fillText(
        `${row.record} · ${row.wins} proj W` + (row.division ? ` · div ${row.division}` : ""),
        left, row.y + 62,
      );
    } else {
      ctx.textAlign = "right";
      ctx.fillStyle = SHADES.muted;
      ctx.font = "600 28px " + FONT;
      ctx.fillText(row.record, 470, mid);
      ctx.fillText(row.wins, 590, mid);
    }

    ctx.fillStyle = SHADES.chip;
    roundRect(ctx, barLeft, mid - 16, barRight - barLeft, 14, 7);
    ctx.fill();

    if (row.fill > 0) {
      ctx.fillStyle = SHADES.go;
      // never narrower than it is tall, so a sliver of a chance is a dot
      roundRect(ctx, barLeft, mid - 16, Math.max(14, (barRight - barLeft) * row.fill), 14, 7);
      ctx.fill();
    }

    ctx.textAlign = "right";
    ctx.fillStyle = SHADES.ink;
    ctx.font = "800 30px " + FONT;
    ctx.fillText(row.odds, colAt[0]!, mid);

    const rest = [row.bye, row.title].filter((v): v is string => v !== null);

    ctx.fillStyle = SHADES.muted;
    ctx.font = "700 28px " + FONT;
    rest.forEach((v, i) => ctx.fillText(v, colAt[i + 1]!, mid));
  }

  if (layout.cut !== null) {
    ctx.strokeStyle = SHADES.faint;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(PAD, layout.cut - 4);
    ctx.lineTo(layout.width - PAD, layout.cut - 4);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export const sharePlayoffs = (layout: PlayoffPicture) =>
  sharePicture(layout, paintPlayoffs);

export interface TableRowText {
  y: number;
  cells: string[];
  mine: boolean;
}

export interface TablePicture extends Picture {
  heads: string[];
  rows: TableRowText[];
}

export function layoutSeasonTable(input: {
  league: string;
  week: number;
  teams: {
    name: string; record: string; pf: number; pa: number;
    allPlay: number; luck: number; efficiency: number | null; mine: boolean;
  }[];
}): TablePicture {
  const top = HEAD + COLUMNS;
  const rows = input.teams.map((team, at): TableRowText => ({
    y: top + at * ROW,
    cells: [
      team.name,
      team.record,
      team.pf.toFixed(1),
      team.pa.toFixed(1),
      pctText(team.allPlay),
      (team.luck >= 0 ? "+" : "") + team.luck.toFixed(1),
      team.efficiency === null ? "–" : pctText(team.efficiency),
    ],
    mine: team.mine,
  }));

  return {
    width: WIDTH,
    height: top + rows.length * ROW + FOOT + PAD,
    title: input.league,
    subtitle: `the season through week ${input.week}`,
    footer: `${SITE} · all-play: vs everybody, every week · eff: starters over best lineup`,
    heads: ["TEAM", "W-L", "PF", "PA", "ALL-PLAY", "LUCK", "EFF"],
    rows,
  };
}

/** the right edge of each column after the name */
const TABLE_AT = [0, 465, 590, 715, 835, 925, 1016];

export function paintSeasonTable(ctx: CanvasRenderingContext2D, layout: TablePicture) {
  const left = PAD + 24;

  ctx.fillStyle = SHADES.faint;
  ctx.font = "700 20px " + FONT;
  layout.heads.forEach((head, i) => {
    ctx.textAlign = i === 0 ? "left" : "right";
    ctx.fillText(head, i === 0 ? left : TABLE_AT[i]!, HEAD + 24);
  });

  for (const row of layout.rows) {
    if (row.mine) {
      ctx.fillStyle = SHADES.panel;
      roundRect(ctx, PAD, row.y, layout.width - PAD * 2, ROW - 8, 14);
      ctx.fill();
    }

    const mid = row.y + ROW / 2 + 6;

    row.cells.forEach((cell, i) => {
      ctx.textAlign = i === 0 ? "left" : "right";
      ctx.fillStyle = i === 0 ? SHADES.ink : SHADES.muted;
      ctx.font = (i === 0 && row.mine ? "800 " : "600 ") +
        (i === 0 ? "28px " : "26px ") + FONT;
      ctx.fillText(i === 0 ? fitted(ctx, cell, 300) : cell,
        i === 0 ? left : TABLE_AT[i]!, mid);
    });
  }
}

export const shareSeasonTable = (layout: TablePicture) =>
  sharePicture(layout, paintSeasonTable);

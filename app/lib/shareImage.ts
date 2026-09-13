/**
 * A week's matchups as one tall PNG, for pasting into the league chat.
 *
 * The picture is drawn by hand on a canvas rather than captured from the
 * page, so what it shows does not depend on how the page happens to be
 * laid out on the phone that made it. The colours are the dark palette
 * written out, because the people it gets sent to have their own themes
 * and a share image should look the same to all of them.
 *
 * Everything except drawOn() is arithmetic over the matchup data, so the
 * layout and the words can be tested where there is no canvas.
 */

/** the dark palette from style.css, written out so a share looks the same to everyone */
export const SHADES = {
  bg: "#10141C",
  panel: "#1A2029",
  edge: "#2A3342",
  ink: "#E8ECF2",
  muted: "#8B95A5",
  faint: "#5B6575",
  go: "#35C06F",
  chip: "#232B38",
};

export const FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export interface ShareSide {
  /** the team's name in the league */
  name: string;
  /** who runs it, when the league says */
  owner?: string | undefined;
  points: number;
  projected: number;
  /** how often this side wins from here, 0 to 1 */
  odds: number;
}

export interface ShareGame {
  sides: [ShareSide, ShareSide];
}

export interface ShareWeek {
  league: string;
  week: number;
  games: ShareGame[];
}

/** what the app calls itself, the same word the nav shows */
export const SITE = "onlydrafts";

/** the export is a fixed width, so a phone and a laptop make the same picture */
export const WIDTH = 1080;
const PAD = 40;
const HEAD = 152;
const FOOT = 72;
const CARD_GAP = 20;
const CARD_BASE = 212;
const CARD_OWNER = 26;

/** one side of one card, with everything already turned into words */
export interface SideText {
  name: string;
  owner: string | null;
  points: string;
  projected: string;
  odds: string;
  /** the favoured side is the one drawn in green */
  favoured: boolean;
}

export interface CardLayout {
  y: number;
  height: number;
  sides: [SideText, SideText];
  /** how much of the bar the left side fills, 0 to 1 */
  fill: number;
}

export interface Layout {
  width: number;
  height: number;
  title: string;
  subtitle: string;
  footer: string;
  cards: CardLayout[];
}

export function pctText(odds: number): string {
  return Math.round(odds * 100) + "%";
}

function sideText(side: ShareSide, favoured: boolean): SideText {
  return {
    name: side.name,
    owner: side.owner && side.owner !== side.name ? side.owner : null,
    points: side.points.toFixed(1),
    projected: side.projected.toFixed(1) + " proj",
    odds: pctText(side.odds),
    favoured,
  };
}

/**
 * Where every card goes and what it says. A tie leaves neither side
 * green, since marking both would say the same thing as marking neither
 * and reads as a bug.
 */
export function layoutWeek(week: ShareWeek): Layout {
  let y = HEAD;
  const cards = week.games.map((game) => {
    const [home, away] = game.sides;
    const owners = game.sides.some((s) => s.owner && s.owner !== s.name);
    const height = CARD_BASE + (owners ? CARD_OWNER : 0);
    const card: CardLayout = {
      y,
      height,
      sides: [
        sideText(home, home.odds > away.odds),
        sideText(away, away.odds > home.odds),
      ],
      fill: Math.min(1, Math.max(0, home.odds)),
    };

    y += height + CARD_GAP;

    return card;
  });

  return {
    width: WIDTH,
    height: y - (cards.length ? CARD_GAP : 0) + FOOT,
    title: week.league,
    subtitle: "week " + week.week,
    footer: SITE,
    cards,
  };
}

/** one game on its own, so a single card shares the same way a week does */
export function layoutGame(
  league: string, week: number, game: ShareGame,
): Layout {
  return layoutWeek({ league, week, games: [game] });
}

/** every word the picture shows, in reading order, for tests */
export function textOf(layout: Layout): string[] {
  const words = [layout.title, layout.subtitle];

  for (const card of layout.cards) {
    for (const side of card.sides) {
      words.push(side.name);

      if (side.owner) {
        words.push(side.owner);
      }

      words.push(side.points, side.projected, side.odds);
    }
  }

  words.push(layout.footer);

  return words;
}

/** shortens a name that would run past the space it has */
function fitted(
  ctx: CanvasRenderingContext2D, text: string, width: number,
): string {
  if (ctx.measureText(text).width <= width) {
    return text;
  }

  let cut = text;

  while (cut.length > 1 && ctx.measureText(cut + "...").width > width) {
    cut = cut.slice(0, -1);
  }

  return cut + "...";
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSide(
  ctx: CanvasRenderingContext2D, side: SideText, at: 0 | 1,
  left: number, right: number, top: number,
) {
  const x = at ? right : left;
  const half = (right - left - 40) / 2;

  ctx.textAlign = at ? "right" : "left";

  ctx.fillStyle = side.favoured ? SHADES.go : SHADES.ink;
  ctx.font = "700 30px " + FONT;
  ctx.fillText(fitted(ctx, side.name, half), x, top + 30);

  let y = top + 30;

  if (side.owner) {
    y += CARD_OWNER;
    ctx.fillStyle = SHADES.faint;
    ctx.font = "500 22px " + FONT;
    ctx.fillText(fitted(ctx, side.owner, half), x, y);
  }

  ctx.fillStyle = SHADES.ink;
  ctx.font = "800 46px " + FONT;
  ctx.fillText(side.points, x, y + 52);

  ctx.fillStyle = SHADES.muted;
  ctx.font = "600 24px " + FONT;
  ctx.fillText(side.projected, x, y + 86);

  ctx.fillStyle = side.favoured ? SHADES.go : SHADES.muted;
  ctx.font = "800 26px " + FONT;
  ctx.fillText(side.odds, x, y + 120);
}

/** the only part that touches a canvas */
export function drawOn(canvas: HTMLCanvasElement, layout: Layout, scale = 2) {
  canvas.width = layout.width * scale;
  canvas.height = layout.height * scale;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("no 2d canvas to draw the share image on");
  }

  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = SHADES.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  ctx.textAlign = "left";
  ctx.fillStyle = SHADES.ink;
  ctx.font = "800 44px " + FONT;
  ctx.fillText(fitted(ctx, layout.title, layout.width - PAD * 2), PAD, PAD + 44);

  ctx.fillStyle = SHADES.muted;
  ctx.font = "600 28px " + FONT;
  ctx.fillText(layout.subtitle, PAD, PAD + 86);

  const left = PAD + 28;
  const right = layout.width - PAD - 28;

  for (const card of layout.cards) {
    ctx.fillStyle = SHADES.panel;
    roundRect(ctx, PAD, card.y, layout.width - PAD * 2, card.height, 18);
    ctx.fill();
    ctx.strokeStyle = SHADES.edge;
    ctx.lineWidth = 2;
    ctx.stroke();

    drawSide(ctx, card.sides[0], 0, left, right, card.y + 26);
    drawSide(ctx, card.sides[1], 1, left, right, card.y + 26);

    const bar = card.y + card.height - 30;
    const wide = right - left;

    ctx.fillStyle = SHADES.chip;
    roundRect(ctx, left, bar, wide, 12, 6);
    ctx.fill();
    ctx.fillStyle = SHADES.go;
    roundRect(ctx, left, bar, Math.max(2, wide * card.fill), 12, 6);
    ctx.fill();
  }

  ctx.textAlign = "left";
  ctx.fillStyle = SHADES.faint;
  ctx.font = "600 24px " + FONT;
  ctx.fillText(layout.footer, PAD, layout.height - PAD + 8);
}

export function canvasFor(layout: Layout, scale = 2): HTMLCanvasElement {
  const canvas = document.createElement("canvas");

  drawOn(canvas, layout, scale);

  return canvas;
}

export function pngOf(layout: Layout, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvasFor(layout, scale).toBlob(
      (blob) => blob
        ? resolve(blob)
        : reject(new Error("the browser would not make a PNG")),
      "image/png",
    );
  });
}

/** a file name the chat app will show, like onlydrafts-week-3.png */
export function fileNameFor(layout: Layout): string {
  return SITE + "-" + layout.subtitle.replace(/\s+/g, "-") + ".png";
}

/**
 * Hands the picture to the phone's share sheet when it takes files, and
 * otherwise falls back to a download. A cancelled share throws, and
 * there is nothing to say about it, so it is swallowed.
 */
export async function shareLayout(layout: Layout): Promise<void> {
  try {
    const blob = await pngOf(layout);
    const name = fileNameFor(layout);
    const title = layout.title + " " + layout.subtitle;
    const file = new File([blob], name, { type: "image/png" });

    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title });

      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = name;
    link.rel = "noopener";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    // a cancelled share sheet lands here, and it means nothing went wrong
  }
}

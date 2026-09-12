/**
 * The shape of the reduced tables, shared by the script that writes
 * them and the browser engine that plays games with them.
 *
 * Everything large is a base64 string of bytes, laid out in the loop
 * order the band counts below imply, slowest axis first. A rate is the
 * byte over 255; a gain is the byte less YARD_OFFSET.
 */

export const DIST_BANDS = 4;
export const FIELD_BANDS = 5;
export const MARGIN_BANDS = 7;
export const TIME_BANDS = 4;
export const QUANTILES = 16;

/** what is added to a gain so a loss still fits in a byte */
export const YARD_OFFSET = 20;

export const distBand = (toGo: number) =>
  toGo <= 2 ? 0 : toGo <= 6 ? 1 : toGo <= 10 ? 2 : 3;

export const fieldBand = (yardline: number) =>
  yardline <= 10 ? 0 : yardline <= 20 ? 1 : yardline <= 50 ? 2
    : yardline <= 80 ? 3 : 4;

export const marginBand = (margin: number) =>
  margin <= -9 ? 0 : margin <= -4 ? 1 : margin < 0 ? 2 : margin === 0 ? 3
    : margin <= 3 ? 4 : margin <= 8 ? 5 : 6;

export const timeBand = (secondsLeft: number) =>
  secondsLeft > 1800 ? 0 : secondsLeft > 900 ? 1 : secondsLeft > 300 ? 2 : 3;

/** the gain band a snap's yards fall in, for the clock table */
export const gainBand = (yards: number) =>
  yards < -1 ? 0 : yards < 1 ? 1 : yards <= 5 ? 2 : yards <= 12 ? 3 : 4;

export interface SimMan {
  id: string;
  /** his name normalized the way the slate keys men */
  key: string;
  position: string;
}

export interface SimTeam {
  passer: string;
  men: SimMan[];
  /** down, distance, field, margin, time */
  runRate: string;
  /** call, early or late down, field, then one byte a man */
  shares: string;
  /** a man and a call, in the order the men are listed */
  caught: string;
  gains: Record<string, string>;
}

export interface SimLeague {
  kickSucceeds: string;
  puntQuantiles: Record<number, string>;
  turnover: string;
  secondsFor: string;
  gainScale: string;
  fourth: string;
  goesForTwo: string;
  penaltyQuantiles: string;
  twoPointRate: number;
  extraPointRate: number;
  matchup: Record<string, string>;
  teamOrder: string[];
  rules: {
    penaltyFirstDown: number;
    offenceFlag: number;
    defenceFlag: number;
    maxPlays: number;
    isLast: number;
  };
}

export interface SimTables {
  season: number;
  week: number;
  teams: Record<string, SimTeam>;
  league: SimLeague;
}

const fromBase64 = (text: string): Uint8Array => {
  if (typeof atob === "function") {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }

    return out;
  }

  return new Uint8Array(Buffer.from(text, "base64"));
};

export const bytesOf = (text: string): Uint8Array => fromBase64(text);

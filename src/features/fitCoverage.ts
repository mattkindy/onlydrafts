/**
 * Who a side throws to depends on what the defence is playing.
 *
 * A receiver's slice of his own side's throws moves a long way with
 * the coverage: at the tenth percentile a man takes .70 of his zone
 * slice when it is man, at the ninetieth 1.59, and where he sits
 * lasts from one season to the next at .32. Nothing in the walk knew
 * this, so a man beat man coverage and zone coverage alike.
 *
 * The defence picks its look, so this fits two things: how often each
 * defence plays man, and how much each receiver's share moves when it
 * does. Coverage is only recorded from 2023, so both fall back to
 * saying nothing rather than guessing.
 */

export interface CoverageRow {
  season: number;
  offence: string;
  defence: string;
  player: string;
  manZone: string;
}

export interface Coverage {
  /** how often this defence plays man, near the league's rate */
  manRate: (defence?: string) => number;
  /**
   * How much of his usual share he takes under man, near one. The
   * caller mixes it by how likely man is on this play.
   */
  underMan: (player: string) => number;
  learnedFrom: number;
}

/** a man needs this many looks of each kind before he is believed */
const ENOUGH = 15;
/** and his lean is pulled toward one by how many he has */
const SETTLES_AT = Number(process.env["COVER_SETTLES"] ?? 60);

export function fitCoverage(rows: CoverageRow[]): Coverage {
  const byDefence = new Map<string, { man: number; all: number }>();
  const his = new Map<string, { man: number; zone: number }>();
  const side = new Map<string, { man: number; zone: number }>();
  let leagueMan = 0;
  let leagueAll = 0;

  for (const row of rows) {
    if (row.manZone !== "man" && row.manZone !== "zone") {
      continue;
    }

    const isMan = row.manZone === "man";
    const d = byDefence.get(row.defence) ?? { man: 0, all: 0 };
    d.all++;
    if (isMan) d.man++;
    byDefence.set(row.defence, d);
    leagueAll++;
    if (isMan) leagueMan++;

    if (!row.player) {
      continue;
    }

    const own = his.get(row.player) ?? { man: 0, zone: 0 };
    own[row.manZone]++;
    his.set(row.player, own);
    const team = side.get(`${row.season}|${row.offence}`) ??
      { man: 0, zone: 0 };
    team[row.manZone]++;
    side.set(`${row.season}|${row.offence}`, team);
  }

  const league = leagueAll > 0 ? leagueMan / leagueAll : 0.5;
  const leaning = new Map<string, number>();

  for (const [player, own] of his) {
    if (own.man < ENOUGH || own.zone < ENOUGH) {
      continue;
    }

    /**
     * His share under man against his share under zone, both taken
     * over what his side threw under each, so a man on a side that
     * faced more man is not read as favoured by it.
     */
    const underMan = own.man / Math.max(1, leagueMan);
    const underZone = own.zone / Math.max(1, leagueAll - leagueMan);

    if (underZone <= 0) {
      continue;
    }

    const trust = (own.man + own.zone) / (own.man + own.zone + SETTLES_AT);
    const raw = underMan / underZone;
    leaning.set(player, Math.max(0.6, Math.min(1.6,
      trust * raw + (1 - trust))));
  }

  return {
    learnedFrom: leaning.size,
    manRate: (defence) => {
      const d = defence ? byDefence.get(defence) : undefined;

      if (!d || d.all < 200) {
        return league;
      }

      const trust = d.all / (d.all + 400);

      return Math.max(0.1, Math.min(0.9,
        trust * (d.man / d.all) + (1 - trust) * league));
    },
    underMan: (player) => leaning.get(player) ?? 1,
  };
}

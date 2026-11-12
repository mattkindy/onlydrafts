/**
 * The board's word on a player's next seasons, his age and where he was
 * drafted, for a keeper or a dynasty league to price him by.
 *
 * `scripts/buildSite.ts` writes these onto every quarterback, back,
 * receiver and tight end, and `app/lib/trade.ts` reads the seasons
 * ahead: one is worth his points a game then, which is `of` times his
 * `ppg` in the league in front of it, less the last starter's, over
 * `games`. The app loads the age and the draft and shows neither yet.
 */

import {
  ageOn, HORIZONS, readSeasons, rowsAt, AHEAD_POSITIONS,
  type AheadRow, type Drafted, type FiledAt, type Person,
} from "./aheadRows.js";
import {
  aheadField, fitSeasonsAhead, predictAhead, type SeasonAhead,
} from "../model/seasonsAhead.js";
import type { ScoringRules } from "../scoring/fantasyPoints.js";

/** the first season the files are read from, and the first a row is cut in */
const FIRST_READ = 2015;
const FIRST_ROW = 2016;

/** what the board writes on a player, any of it absent where nothing is known */
export interface AheadFields {
  ahead?: { of: number; games: number }[];
  age?: number;
  drafted?: Drafted | null;
}

export interface SeasonsAhead {
  /** each player's next seasons, the coming one first */
  said: Map<string, (SeasonAhead | undefined)[]>;
  people: Map<string, Person>;
  /** the rows of the board's own season, for anybody who wants to look */
  rows: AheadRow[];
}

/**
 * Every skill player's next three seasons as of the board's week, from a
 * fit taught on every earlier season cut at the same week whose seasons
 * ahead have finished. `filedAt` is where the board has each player, for
 * the few the stats file has somewhere else.
 */
export async function seasonsAheadFor(
  season: number, week: number, rules: ScoringRules, filedAt: FiledAt = new Map(),
): Promise<SeasonsAhead> {
  const { reads, people } = await readSeasons(FIRST_READ, season, rules, filedAt);
  const taught: AheadRow[] = [];

  for (let s = FIRST_ROW; s < season; s++) {
    taught.push(...rowsAt(s, week, reads, people));
  }

  const fits = fitSeasonsAhead(taught);
  const rows = rowsAt(season, week, reads, people);
  const said = new Map(rows.map((row) =>
    [row.playerId, fits.map((fit) => predictAhead(fit, row))]));

  return { said, people, rows };
}

/**
 * The fields one board player gets. Kickers and defences get none, a
 * player the players file does not know gets no age or draft, and a
 * player with no row at the board's week, or a rate on the board too
 * small to be a ratio of, gets no seasons ahead.
 */
export function aheadFields(
  player: { playerId: string; position: string; ppg: number },
  season: number,
  found: Pick<SeasonsAhead, "said" | "people">,
): AheadFields {
  if (!AHEAD_POSITIONS.includes(player.position)) {
    return {};
  }

  const person = found.people.get(player.playerId);
  const said = found.said.get(player.playerId);
  const ahead = said && said.length === HORIZONS
    ? aheadField(said, player.ppg)
    : undefined;
  const age = ageOn(person?.birthDate, season);

  return {
    ...(ahead ? { ahead } : {}),
    ...(age !== undefined ? { age } : {}),
    ...(person ? { drafted: person.drafted } : {}),
  };
}

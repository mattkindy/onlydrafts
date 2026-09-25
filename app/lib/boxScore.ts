/**
 * What a player has actually done in a game that is on or over, read off
 * the same record the league scores him from.
 *
 * Taking the points from the league and the line from ESPN's public box
 * score put two clocks on one card, and it could say 10 points beside
 * 138 yards in a league paying a tenth a yard. Each provider hands back
 * one record per player for the week, and both come off that record.
 *
 * Sleeper's record is keyed by the names its leagues price things under
 * (rec_yd, pass_td), and ESPN's by the number it gives each stat. Only
 * the figures a matchup row has room for are kept.
 */

/** the few numbers a matchup row has room to say */
export interface StatLine {
  passCmp: number;
  passAtt: number;
  passYds: number;
  passTd: number;
  interceptions: number;
  carries: number;
  rushYds: number;
  rushTd: number;
  receptions: number;
  targets: number;
  recYds: number;
  recTd: number;
  fgm: number;
  fga: number;
  xpm: number;
  xpa: number;
  fumblesLost: number;
}

/** what a team's defence has done */
export interface DefenceLine {
  allowed: number;
  sacks: number;
  picks: number;
  recovered: number;
  defTd: number;
}

/**
 * A player's week so far, from his league's own feed. A defence is read
 * by different figures from everybody else, so the two are kept apart.
 */
export type PlayerStats =
  | { kind: "player"; line: StatLine }
  | { kind: "defence"; line: DefenceLine };

/** one provider's record for one player in one week, by its own stat names */
export type StatRecord = Record<string, number | null | undefined>;

/** the provider's names for each figure, added up where there are several */
type Names<T> = Record<keyof T, (string | number)[]>;

const count = (record: StatRecord, names: (string | number)[]) =>
  names.reduce<number>((sum, name) => {
    const n = record[String(name)];

    return sum + (typeof n === "number" && Number.isFinite(n) ? n : 0);
  }, 0);

function lineFrom<T>(record: StatRecord, names: Names<T>): T {
  const pairs = Object.entries(names) as [string, (string | number)[]][];

  return Object.fromEntries(
    pairs.map(([field, called]) => [field, count(record, called)]),
  ) as T;
}

function statsFrom(
  record: StatRecord,
  position: string | undefined,
  player: Names<StatLine>,
  defence: Names<DefenceLine>,
): PlayerStats {
  if (position === "DEF") {
    return { kind: "defence", line: lineFrom(record, defence) };
  }

  return { kind: "player", line: lineFrom(record, player) };
}

const SLEEPER_LINE: Names<StatLine> = {
  passCmp: ["pass_cmp"], passAtt: ["pass_att"], passYds: ["pass_yd"],
  passTd: ["pass_td"], interceptions: ["pass_int"],
  carries: ["rush_att"], rushYds: ["rush_yd"], rushTd: ["rush_td"],
  receptions: ["rec"], targets: ["rec_tgt"], recYds: ["rec_yd"],
  recTd: ["rec_td"],
  fgm: ["fgm"], fga: ["fga"], xpm: ["xpm"], xpa: ["xpa"],
  fumblesLost: ["fum_lost"],
};

const SLEEPER_DEFENCE: Names<DefenceLine> = {
  allowed: ["pts_allow"], sacks: ["sack"], picks: ["int"],
  recovered: ["fum_rec"], defTd: ["def_td"],
};

/**
 * ESPN's stat numbers. 53 is the catch its leagues pay for, where 41
 * counts the same catches again, and a defence's touchdowns are split
 * by how it scored them.
 */
const ESPN_LINE: Names<StatLine> = {
  passCmp: [1], passAtt: [0], passYds: [3], passTd: [4], interceptions: [20],
  carries: [23], rushYds: [24], rushTd: [25],
  receptions: [53], targets: [58], recYds: [42], recTd: [43],
  fgm: [83], fga: [84], xpm: [86], xpa: [87],
  fumblesLost: [72],
};

const ESPN_DEFENCE: Names<DefenceLine> = {
  allowed: [120], sacks: [99], picks: [95], recovered: [96],
  defTd: [93, 101, 102, 103, 104],
};

/** a player's line off Sleeper's weekly stats record for him */
export const sleeperStatsOf = (
  record: StatRecord, position: string | undefined,
): PlayerStats => statsFrom(record, position, SLEEPER_LINE, SLEEPER_DEFENCE);

/** and off the stats ESPN puts on a roster entry for the week */
export const espnStatsOf = (
  record: StatRecord, position: string | undefined,
): PlayerStats => statsFrom(record, position, ESPN_LINE, ESPN_DEFENCE);

/** a touchdown count, left out when he has not scored */
const scored = (td: number) => td > 0 ? `, ${td} TD` : "";

const passingSays = (line: StatLine) =>
  `${line.passCmp}/${line.passAtt}, ${line.passYds} yds` +
  scored(line.passTd) +
  (line.interceptions > 0 ? `, ${line.interceptions} INT` : "");

const rushingSays = (line: StatLine) =>
  `${line.carries} car, ${line.rushYds} yds` + scored(line.rushTd);

const receivingSays = (line: StatLine) =>
  `${line.receptions}/${line.targets} rec, ${line.recYds} yds` +
  scored(line.recTd);

const threwAtAll = (line: StatLine) => line.passAtt > 0;

const ranAtAll = (line: StatLine) => line.rushYds !== 0 || line.rushTd > 0;

const carriedAtAll = (line: StatLine) => line.carries > 0 || ranAtAll(line);

const caughtAtAll = (line: StatLine) =>
  line.receptions > 0 || line.targets > 0;

const kickedAtAll = (line: StatLine) => line.fga > 0 || line.xpa > 0;

const fumbled = (line: StatLine) =>
  line.fumblesLost > 0 ? `, ${line.fumblesLost} FUM` : "";

/**
 * Passing, rushing and receiving each on a line of their own. A lost
 * fumble goes on the rushing line, since that is where most of them
 * happen, and on the last line there is when he never ran.
 */
function withFumbles(lines: (string | null)[], line: StatLine): string[] {
  const said = lines.filter((piece): piece is string => piece !== null);
  const lost = fumbled(line);

  if (!lost || !said.length) {
    return said;
  }

  const ran = said.findIndex((piece) => piece.includes(" car,"));
  const at = ran >= 0 ? ran : said.length - 1;

  said[at] += lost;

  return said;
}

const quarterbackSays = (line: StatLine) => withFumbles([
  threwAtAll(line) ? passingSays(line) : null,
  ranAtAll(line) ? rushingSays(line) : null,
], line);

const runnerSays = (line: StatLine) => withFumbles([
  carriedAtAll(line) ? rushingSays(line) : null,
  caughtAtAll(line) ? receivingSays(line) : null,
], line);

const catcherSays = (line: StatLine) => withFumbles([
  caughtAtAll(line) ? receivingSays(line) : null,
  ranAtAll(line) ? rushingSays(line) : null,
], line);

const kickerSays = (line: StatLine) => kickedAtAll(line)
  ? [`${line.fgm}/${line.fga} FG, ${line.xpm}/${line.xpa} XP`]
  : [];

const SAYS: Record<string, (line: StatLine) => string[]> = {
  QB: quarterbackSays,
  RB: runnerSays,
  WR: catcherSays,
  TE: catcherSays,
  K: kickerSays,
};

/**
 * His line as a box score would read it out, in the position's own terms,
 * one line each for passing, rushing and receiving.
 *
 * A position nobody keeps a line for, a defence above all, says nothing,
 * and so does a player who has not touched the ball yet.
 */
export function statLineSays(
  line: StatLine | undefined, position: string | undefined,
): string[] {
  const says = SAYS[(position ?? "").toUpperCase()];

  if (!line || !says) {
    return [];
  }

  return says(line);
}

const counted = (n: number, what: string) => n > 0 ? `, ${n} ${what}` : "";

/** what a defence has allowed on one line, and what it has taken on the next */
export function defenceLineSays(line: DefenceLine | undefined): string[] {
  if (!line) {
    return [];
  }

  const taken = (
    counted(line.sacks, line.sacks === 1 ? "sack" : "sacks") +
    counted(line.picks, "INT") + counted(line.recovered, "FR") +
    counted(line.defTd, "TD")
  ).slice(2);

  const allowed = `${line.allowed} allowed`;

  return taken ? [allowed, taken] : [allowed];
}

type Says = (stats: PlayerStats, position: string | undefined) => string[];

const STATS_SAY: Record<PlayerStats["kind"], Says> = {
  player: (stats, position) =>
    statLineSays(stats.kind === "player" ? stats.line : undefined, position),
  defence: (stats) =>
    defenceLineSays(stats.kind === "defence" ? stats.line : undefined),
};

/** whatever a player's week says, in the terms his position is read by */
export function statsSay(
  stats: PlayerStats | undefined, position: string | undefined,
): string[] {
  if (!stats) {
    return [];
  }

  return STATS_SAY[stats.kind](stats, position);
}

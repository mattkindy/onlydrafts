/**
 * What a player has actually done in a game that is on or over.
 *
 * ESPN's game summary includes a box score alongside the injury list, one
 * entry per team, each with a table per category (passing, rushing,
 * receiving, kicking, fumbles). Every table lists its column names in
 * `keys`, and each athlete's `stats` are in that same order, so a column
 * is looked up by name rather than by counting. A player turns up in as
 * many tables as he did things in, and they all fold into one line.
 *
 * Only the figures a fantasy card shows are kept. Sacks, punt returns and
 * the defensive tables are read past, because a matchup row has room for
 * about twenty eight characters and none of that would earn the space.
 */

import { normalizeName } from "./store.ts";

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

interface Athlete {
  athlete?: { displayName?: string; fullName?: string };
  stats?: string[];
}

interface Category {
  name?: string;
  keys?: string[];
  athletes?: Athlete[];
  /** the team's column sums, which is all a defence's line needs */
  totals?: string[];
}

interface TeamBox {
  team?: { abbreviation?: string };
  statistics?: Category[];
}

/** the part of ESPN's game summary this file reads */
export interface BoxScoreSaid {
  boxscore?: { players?: TeamBox[] };
  header?: { competitions?: { competitors?: Competitor[] }[] };
}

const EMPTY: StatLine = {
  passCmp: 0, passAtt: 0, passYds: 0, passTd: 0, interceptions: 0,
  carries: 0, rushYds: 0, rushTd: 0,
  receptions: 0, targets: 0, recYds: 0, recTd: 0,
  fgm: 0, fga: 0, xpm: 0, xpa: 0, fumblesLost: 0,
};

/** one column of an athlete's row, by the name the table gives it */
type Said = (key: string) => string;

const number = (said: string | undefined) => {
  const n = Number(said);

  return Number.isFinite(n) ? n : 0;
};

/** ESPN writes a made and attempted pair as one "3/4" column */
function pair(said: string): [number, number] {
  const halves = said.split("/");

  return [number(halves[0]), number(halves[1])];
}

/** what each category contributes to a player's line */
const FROM: Record<string, (said: Said) => Partial<StatLine>> = {
  passing: (said) => {
    const [passCmp, passAtt] = pair(said("completions/passingAttempts"));

    return {
      passCmp, passAtt,
      passYds: number(said("passingYards")),
      passTd: number(said("passingTouchdowns")),
      interceptions: number(said("interceptions")),
    };
  },
  rushing: (said) => ({
    carries: number(said("rushingAttempts")),
    rushYds: number(said("rushingYards")),
    rushTd: number(said("rushingTouchdowns")),
  }),
  receiving: (said) => ({
    receptions: number(said("receptions")),
    targets: number(said("receivingTargets")),
    recYds: number(said("receivingYards")),
    recTd: number(said("receivingTouchdowns")),
  }),
  kicking: (said) => {
    const [fgm, fga] = pair(said("fieldGoalsMade/fieldGoalAttempts"));
    const [xpm, xpa] = pair(said("extraPointsMade/extraPointAttempts"));

    return { fgm, fga, xpm, xpa };
  },
  fumbles: (said) => ({ fumblesLost: number(said("fumblesLost")) }),
};

const nothingIn = (line: StatLine) =>
  Object.values(line).every((n) => n === 0);

/**
 * Every player's line in one game, keyed the way the slate keys a player
 * so a matchup row can look him up by the same key it uses for injuries.
 */
export function statLinesFrom(said: BoxScoreSaid): Map<string, StatLine> {
  const out = new Map<string, StatLine>();

  for (const team of said.boxscore?.players ?? []) {
    for (const table of team.statistics ?? []) {
      const takes = FROM[table.name ?? ""];

      if (!takes) {
        continue;
      }

      const keys = table.keys ?? [];

      for (const row of table.athletes ?? []) {
        const name = row.athlete?.displayName ?? row.athlete?.fullName;

        if (!name) {
          continue;
        }

        const key = normalizeName(name);
        const column: Said = (of) => row.stats?.[keys.indexOf(of)] ?? "";

        out.set(key, { ...out.get(key) ?? EMPTY, ...takes(column) });
      }
    }
  }

  for (const [key, line] of out) {
    if (nothingIn(line)) {
      out.delete(key);
    }
  }

  return out;
}

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
/** what a team's defence has done, kept on the same line type under the team's key */
export interface DefenceLine {
  allowed: number;
  sacks: number;
  picks: number;
  recovered: number;
  defTd: number;
}

const NO_DEFENCE: DefenceLine = {
  allowed: 0, sacks: 0, picks: 0, recovered: 0, defTd: 0,
};

export interface Competitor {
  homeAway?: string;
  score?: string | number;
  team?: { abbreviation?: string };
}

/** the columns of one team's table added up, by column name */
const totalsOf = (table: Category): Said => {
  const keys = table.keys ?? [];
  const totals = table.totals ?? [];

  return (of) => totals[keys.indexOf(of)] ?? "";
};

/**
 * A recovery is only a takeaway when somebody else fumbled. ESPN lists a
 * player's own fumbles and his recoveries in one table, so a defender's
 * row has no fumbles beside the recovery and a runner falling on his own
 * ball does.
 */
function recoveriesIn(table: Category): number {
  const keys = table.keys ?? [];
  let recovered = 0;

  for (const row of table.athletes ?? []) {
    const column: Said = (of) => row.stats?.[keys.indexOf(of)] ?? "";

    if (number(column("fumbles")) === 0) {
      recovered += number(column("fumblesRecovered"));
    }
  }

  return recovered;
}

const DEFENCE_FROM: Record<string, (table: Category) => Partial<DefenceLine>> = {
  defensive: (table) => {
    const said = totalsOf(table);

    return {
      sacks: number(said("sacks")),
      defTd: number(said("defensiveTouchdowns")),
    };
  },
  interceptions: (table) => {
    const said = totalsOf(table);

    return {
      picks: number(said("interceptions")),
      defTd: number(said("interceptionTouchdowns")),
    };
  },
  fumbles: (table) => ({ recovered: recoveriesIn(table) }),
};

/** what each side has given up, by team code, off the header's scores */
function allowedIn(said: BoxScoreSaid): Map<string, number> {
  const out = new Map<string, number>();
  const sides = said.header?.competitions?.[0]?.competitors ?? [];

  for (const side of sides) {
    const other = sides.find((s) => s !== side);
    const code = side.team?.abbreviation;

    if (code && other) {
      out.set(code, number(String(other.score ?? "")));
    }
  }

  return out;
}

/**
 * Each defence's line, keyed the way a lineup keys a defence, which is
 * its team code run through the same normalizing as a name.
 */
export function defenceLinesFrom(said: BoxScoreSaid): Map<string, DefenceLine> {
  const out = new Map<string, DefenceLine>();
  const allowed = allowedIn(said);

  for (const team of said.boxscore?.players ?? []) {
    const code = team.team?.abbreviation;

    if (!code) {
      continue;
    }

    let line: DefenceLine = { ...NO_DEFENCE, allowed: allowed.get(code) ?? 0 };

    for (const table of team.statistics ?? []) {
      const takes = DEFENCE_FROM[table.name ?? ""];

      if (takes) {
        const took = takes(table);
        line = { ...line, ...took, defTd: line.defTd + (took.defTd ?? 0) };
      }
    }

    out.set(normalizeName(code), line);
  }

  return out;
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

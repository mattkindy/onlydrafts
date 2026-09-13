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
}

interface TeamBox {
  statistics?: Category[];
}

/** the part of ESPN's game summary this file reads */
export interface BoxScoreSaid {
  boxscore?: { players?: TeamBox[] };
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

const caughtSays = (line: StatLine) =>
  `${line.receptions} rec, ${line.recYds} yds` + scored(line.recTd);

/**
 * Targets belong to the player a card is watching for them, so they show
 * for a receiver and stay off a running back's second line, where they
 * would push a phone's row on to a third.
 */
const receivingSays = (line: StatLine) =>
  `${line.receptions} rec` +
  (line.targets > 0 ? ` (${line.targets} tgt)` : "") +
  `, ${line.recYds} yds` + scored(line.recTd);

const threwAtAll = (line: StatLine) => line.passAtt > 0;

const ranAtAll = (line: StatLine) => line.rushYds !== 0 || line.rushTd > 0;

const carriedAtAll = (line: StatLine) => line.carries > 0 || ranAtAll(line);

const caughtAtAll = (line: StatLine) =>
  line.receptions > 0 || line.targets > 0;

const kickedAtAll = (line: StatLine) => line.fga > 0 || line.xpa > 0;

/** the pieces of a line, middle dots between them */
const joined = (pieces: (string | null)[]) =>
  pieces.filter((piece) => piece !== null).join(" · ");

// after a dot the carries have already been set off from the passing, so
// the comma inside them would be one break too many
const asSecondThought = (said: string) => said.replace(" car,", " car");

const quarterbackSays = (line: StatLine) => joined([
  threwAtAll(line) ? passingSays(line) : null,
  ranAtAll(line) ? asSecondThought(rushingSays(line)) : null,
]);

const runnerSays = (line: StatLine) => joined([
  carriedAtAll(line) ? rushingSays(line) : null,
  caughtAtAll(line) ? caughtSays(line) : null,
]);

const catcherSays = (line: StatLine) => joined([
  caughtAtAll(line) ? receivingSays(line) : null,
  ranAtAll(line) ? rushingSays(line) : null,
]);

const kickerSays = (line: StatLine) => kickedAtAll(line)
  ? `${line.fgm}/${line.fga} FG, ${line.xpm}/${line.xpa} XP`
  : "";

const SAYS: Record<string, (line: StatLine) => string> = {
  QB: quarterbackSays,
  RB: runnerSays,
  WR: catcherSays,
  TE: catcherSays,
  K: kickerSays,
};

/**
 * His line as a box score would read it out, in the position's own terms.
 *
 * A position nobody keeps a line for, a defence above all, says nothing,
 * and so does a player who has not touched the ball yet.
 */
export function statLineSays(
  line: StatLine | undefined, position: string | undefined,
): string {
  const says = SAYS[(position ?? "").toUpperCase()];

  if (!line || !says) {
    return "";
  }

  const said = says(line);

  if (!said) {
    return "";
  }

  return joined([said, line.fumblesLost > 0 ? `${line.fumblesLost} FUM` : null]);
}

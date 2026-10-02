/**
 * Why a free agent is worth what the season pricer says he is.
 *
 * The pricer draws a few thousand weeks with and without him, and his
 * win chance is the average over those weeks. So his value can be split
 * by why he started in each week he did: one of your starters was on bye,
 * or on the injury report, or missed a game, or he was better than the
 * player he pushed out, or nobody on your roster could fill the slot. The
 * biggest one or two of those become a sentence on his row.
 *
 * A reason only mentions players on your roster. What comes out is plain
 * numbers and strings, since it comes back from the worker.
 */

import { SEASON_WEEKS } from "./availability.ts";
import { FLEX_POSITIONS, lineupOf, type Player } from "./scoring.ts";
import {
  weekOfDraw, weeksOf, type Baseline, type Held, type StartWatch,
} from "./winShare.ts";

export type WhyKind = "over" | "bye" | "hurt" | "missing" | "wire";

/** a bye week he covers, and how often he starts in that week's draws */
export interface ByeCover {
  week: number;
  name: string;
  share: number;
}

export interface WhyPart {
  kind: WhyKind;
  /** how much win chance the weeks in this part add */
  adds: number;
  /** the share of all drawn weeks this part covers */
  starts: number;
  /** the player of yours he plays over or fills in for */
  name: string | null;
  /** how often he outscores the player he replaces in these weeks */
  outscored: number;
  /** the injury report's word, when the player he covers is listed */
  status: string | null;
  /** his position, when the slot he fills is one you have nobody for */
  empty: string | null;
  byes: ByeCover[];
}

export interface Why {
  /** biggest first, and only the parts that add anything */
  parts: WhyPart[];
  /** how often he starts in each week, the first week drawn first */
  weekly: number[];
  from: number;
}

/**
 * A starter is somebody in the lineup in at least half the weeks he plays,
 * so a starter on injured reserve for half the season still counts.
 * A newcomer who starts when one of them is missing is covering for him.
 */
const REGULAR = 0.5;

/** how many drawn weeks he plays in at all */
function playing(q: Player, draws: number): number {
  let n = 0;

  for (const score of weeksOf(q, draws)) {
    n += score > 0 ? 1 : 0;
  }

  return Math.max(1, n);
}

/** a bye week he starts in less often than this is not worth naming */
const COVERS = 0.25;

/** how many parts come back, which is more than a row ever says */
const KEPT = 3;

interface Tally {
  kind: WhyKind;
  who: Player | null;
  week: number | null;
  swing: number;
  starts: number;
  won: number;
}

/** why one of your starters is not playing in a drawn week */
type Gone = "bye" | "hurt" | "missing";

/** the order a reason prefers when two starters are out the same week */
const GONE_FIRST: Record<Gone, number> = { bye: 0, hurt: 1, missing: 2 };

function goneFor(
  q: Player, week: number, hurt: Record<string, string>,
): Gone {
  if (q.bye === week) {
    return "bye";
  }

  if (hurt[q.key] && q.weeksLeft?.plays[week - q.weeksLeft.from] === 0) {
    return "hurt";
  }

  return "missing";
}

/** whether a player at one position can take the slot of one at another */
function overlaps(a: string, b: string, flex: boolean): boolean {
  if (a === b) {
    return true;
  }

  return flex && FLEX_POSITIONS.includes(a) && FLEX_POSITIONS.includes(b);
}

export interface WhyWatch {
  watch: StartWatch;
  done(): Why | null;
}

/**
 * A watcher for each add, to hand the pricer alongside him. `hurt` is what
 * the injury report says of each player by his key.
 */
export function whyFor(
  mine: Player[], slots: string[] | null | undefined, baseline: Baseline,
  draws: number, hurt: Record<string, string> = {},
): (p: Player) => WhyWatch {
  const weeks = Math.max(1, baseline.total.length);
  const byKey = new Map(mine.map((q) => [q.key, q]));
  const regulars = mine
    .filter((q) => (baseline.started[q.key] ?? 0) / playing(q, draws) >= REGULAR)
    .sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0))
    .map((q) => ({ q, its: weeksOf(q, draws) }));
  const regular = new Set(regulars.map(({ q }) => q.key));
  const flex = lineupOf(slots).flex > 0;

  return (p) => {
    const from = p.weeksLeft?.from ?? 1;
    const span = SEASON_WEEKS - from + 1;
    const covering = regulars
      .filter(({ q }) => overlaps(q.position, p.position, flex));
    const tallies = new Map<string, Tally>();
    const startsIn = new Array<number>(span).fill(0);

    /** the starter of yours missing this draw, the likeliest reason first */
    const missingAt = (i: number, week: number) => {
      let best: { q: Player; gone: Gone } | null = null;

      for (const { q, its } of covering) {
        if (its[i]! > 0) {
          continue;
        }

        const gone = goneFor(q, week, hurt);

        if (!best || GONE_FIRST[gone] < GONE_FIRST[best.gone]) {
          best = { q, gone };
        }
      }

      return best;
    };

    const partOf = (
      i: number, week: number, out: Held,
    ): Omit<Tally, "swing" | "starts" | "won"> => {
      if (out.who && regular.has(out.who)) {
        return { kind: "over", who: byKey.get(out.who) ?? null, week: null };
      }

      const missing = missingAt(i, week);

      if (missing) {
        return {
          kind: missing.gone, who: missing.q,
          week: missing.gone === "bye" ? week : null,
        };
      }

      if (!out.who) {
        return { kind: "wire", who: null, week: null };
      }

      return { kind: "over", who: byKey.get(out.who) ?? null, week: null };
    };

    const watch: StartWatch = (i, out, score, swing) => {
      const week = weekOfDraw(i, from);
      startsIn[week - from]!++;
      const part = partOf(i, week, out);
      const key = `${part.kind}|${part.who?.key ?? ""}|${part.week ?? ""}`;
      const had = tallies.get(key)
        ?? { ...part, swing: 0, starts: 0, won: 0 };
      had.swing += swing;
      had.starts++;
      had.won += score > out.score ? 1 : 0;
      tallies.set(key, had);
    };

    const empty = mine.some((q) => q.position === p.position) ? null : p.position;

    return {
      watch,
      done: () => tallies.size
        ? summed([...tallies.values()], weeks, startsIn, from, hurt, empty)
        : null,
    };
  };
}

/** how many drawn weeks fall in each week of the season, from `from` on */
function drawsIn(weeks: number, span: number): number[] {
  return Array.from(
    { length: span },
    (_, k) => Math.floor(weeks / span) + (k < weeks % span ? 1 : 0),
  );
}

function summed(
  tallies: Tally[], weeks: number, startsIn: number[], from: number,
  hurt: Record<string, string>, empty: string | null,
): Why | null {
  const perWeek = drawsIn(weeks, startsIn.length);
  const parts = new Map<string, WhyPart & { won: number }>();

  for (const t of tallies) {
    // every bye he covers is one part, and the games your starters miss
    // for no listed reason are another, whoever missed them
    const key = t.kind === "bye" || t.kind === "missing"
      ? t.kind
      : `${t.kind}|${t.who?.key ?? ""}`;
    const part = parts.get(key) ?? {
      kind: t.kind, adds: 0, starts: 0, name: t.who?.name ?? null,
      outscored: 0, won: 0,
      status: t.kind === "hurt" && t.who ? hurt[t.who.key] ?? null : null,
      empty: t.kind === "wire" ? empty : null,
      byes: [],
    };
    part.adds += t.swing / weeks;
    part.starts += t.starts;
    part.won += t.won;

    if (t.kind === "bye" && t.who && t.week !== null) {
      const share = t.starts / Math.max(1, perWeek[t.week - from] ?? 0);

      if (share >= COVERS) {
        part.byes.push({ week: t.week, name: t.who.name, share });
      }
    }

    parts.set(key, part);
  }

  const kept = [...parts.values()]
    .filter((part) => part.adds > 0)
    .filter((part) => part.kind === "wire" || part.name !== null)
    .filter((part) => part.kind !== "bye" || part.byes.length > 0)
    .sort((a, b) => b.adds - a.adds)
    .slice(0, KEPT)
    .map(({ won, ...part }) => ({
      ...part,
      outscored: won / Math.max(1, part.starts),
      starts: part.starts / weeks,
      byes: [...part.byes].sort((a, b) => b.share - a.share),
    }));

  if (!kept.length) {
    return null;
  }

  return {
    parts: kept,
    weekly: startsIn.map((n, k) => n / Math.max(1, perWeek[k] ?? 0)),
    from,
  };
}

/** a second part is named only when it is at least this much of the first */
const ALSO = 0.25;

/** a week he starts in less often than this, he is not needed */
const SPARE = 0.2;

/** out of ten, which reads easier on a card than a percentage */
const tenths = (share: number) => Math.round(10 * share);

const pctOf = (share: number) => `${Math.round(100 * share)}%`;

/** the injury report's words as a sentence would say them */
const LISTED: Record<string, string> = {
  IR: "on injured reserve",
  PUP: "on the PUP list",
  Sus: "suspended",
  Out: "out",
  Doubtful: "doubtful",
  Questionable: "questionable",
  NA: "not active",
};

const listedAs = (status: string | null) =>
  status ? LISTED[status] ?? `listed ${status}` : "hurt";

/** the bye weeks he covers, the two he starts in most, in calendar order */
function byeWords(byes: ByeCover[]): string {
  const [first, second] = [...byes.slice(0, 2)].sort((a, b) => a.week - b.week);

  if (!first) {
    return "";
  }

  const lead = `starts ${pctOf(first.share)} of the time in week ${first.week}, ` +
    `when ${first.name} is on bye`;

  if (!second) {
    return lead;
  }

  return `${lead}, and ${pctOf(second.share)} in week ${second.week} for ` +
    second.name;
}

const PART_WORDS: Record<WhyKind, (part: WhyPart) => string> = {
  over: (part) => `starts over ${part.name} and outscores him in ` +
    `${tenths(part.outscored)} weeks of 10`,
  bye: (part) => byeWords(part.byes),
  hurt: (part) => `fills in for ${part.name}, who is ${listedAs(part.status)}`,
  missing: (part) => `fills in when ${part.name} misses a game`,
  wire: (part) => part.empty
    ? `you have no ${NOBODY_AT[part.empty] ?? part.empty} to start, so he starts ` +
      `${tenths(part.starts)} weeks of 10`
    : `starts ${tenths(part.starts)} weeks of 10 in a spot nobody on your ` +
      "roster can fill",
};

/** what to call a position when you have nobody there */
const NOBODY_AT: Record<string, string> = {
  QB: "quarterback", RB: "running back", WR: "receiver", TE: "tight end",
  K: "kicker", DEF: "defence",
};

const sentence = (words: string) =>
  words ? words[0]!.toUpperCase() + words.slice(1) + "." : "";

/**
 * The week after which he is no use to you: his biggest reason is the bye
 * weeks he covers, and he seldom starts in any other week.
 */
function dropAfter(why: Why, first: WhyPart): number | null {
  const byes = first.kind === "bye" ? first.byes : [];

  if (!byes.length) {
    return null;
  }

  const last = Math.max(...byes.map((b) => b.week));
  const later = why.weekly.slice(last - why.from + 1);
  const named = new Set(byes.map((b) => b.week));
  const elsewhere = why.weekly.filter((share, k) => !named.has(why.from + k));

  if (!later.length || elsewhere.some((share) => share >= SPARE)) {
    return null;
  }

  return last;
}

/** the biggest one or two reasons he is worth adding, as a short sentence */
export function whyWords(why: Why | null | undefined): string {
  const [first, ...rest] = why?.parts ?? [];

  if (!why || !first) {
    return "";
  }

  const lead = sentence(PART_WORDS[first.kind](first));
  const after = dropAfter(why, first);

  if (after !== null) {
    return `${lead} You can drop him after week ${after}.`;
  }

  // two players he starts over in different weeks read as one reason said twice
  const second = rest.find((part) => part.kind !== first.kind);

  if (!second || second.adds < ALSO * first.adds) {
    return lead;
  }

  return `${lead} ${sentence(PART_WORDS[second.kind](second))}`;
}

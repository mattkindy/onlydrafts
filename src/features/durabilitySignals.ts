/**
 * Signals about a man's season that the availability model has never
 * read: how many weeks his club left him on injured reserve, how many
 * he sat out fit, and what share of his side's snaps he took.
 *
 * Weeks on reserve say what a missing stat line cannot. A man with no
 * line for week nine was either hurt, benched, or rested, and those
 * three say different things about next season.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const RAW = join(import.meta.dirname, "..", "..", "data", "raw");

export interface SeasonSignals {
  /** weeks his club had him on injured reserve */
  onReserve: Map<string, number>;
  /** weeks he was on the roster but made inactive */
  inactive: Map<string, number>;
  /** weeks he was active and available to play */
  activeWeeks: Map<string, number>;
  /** his share of his side's offensive snaps, across the weeks he played */
  snapShare: Map<string, number>;
  /** and the most he ever took in a week, which says what his role is */
  bestSnapShare: Map<string, number>;
  /** how many separate spells on reserve, since two is worse than one */
  reserveSpells: Map<string, number>;
}

function columns(text: string) {
  const lines = text.trim().split("\n");
  const head = lines[0]!.split(",");

  return { head, lines: lines.slice(1) };
}

/** a csv row split on commas outside quotes */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;

  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }

  out.push(cur);

  return out;
}

export async function readSignals(season: number): Promise<SeasonSignals> {
  const out: SeasonSignals = {
    onReserve: new Map(), inactive: new Map(), activeWeeks: new Map(),
    snapShare: new Map(), bestSnapShare: new Map(), reserveSpells: new Map(),
  };

  const roster = await readFile(join(RAW, `roster_weekly_${season}.csv`), "utf8")
    .catch(() => "");

  if (roster) {
    const { head, lines } = columns(roster);
    const at = (name: string) => head.indexOf(name);
    const idAt = at("gsis_id");
    const statusAt = at("status");
    const weekAt = at("week");
    const reserveWeeks = new Map<string, number[]>();

    for (const line of lines) {
      const c = cells(line);
      const id = c[idAt];
      const status = c[statusAt];
      const week = Number(c[weekAt]);

      if (!id || !status || !(week >= 1 && week <= 18)) {
        continue;
      }

      if (status === "RES") {
        out.onReserve.set(id, (out.onReserve.get(id) ?? 0) + 1);
        reserveWeeks.set(id, [...(reserveWeeks.get(id) ?? []), week]);
      } else if (status === "INA") {
        out.inactive.set(id, (out.inactive.get(id) ?? 0) + 1);
      } else if (status === "ACT") {
        out.activeWeeks.set(id, (out.activeWeeks.get(id) ?? 0) + 1);
      }
    }

    for (const [id, weeks] of reserveWeeks) {
      const sorted = [...new Set(weeks)].sort((a, b) => a - b);
      let spells = 1;

      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]! > sorted[i - 1]! + 1) {
          spells++;
        }
      }

      out.reserveSpells.set(id, spells);
    }
  }

  /**
   * Snap share comes keyed by the pro football reference id, and the
   * rest of the model works in gsis ids, so the two are joined through
   * the roster file which carries both.
   */
  const snaps = await readFile(join(RAW, `snap_counts_${season}.csv`), "utf8")
    .catch(() => "");

  if (snaps && roster) {
    const gsisOf = new Map<string, string>();
    const { head: rh, lines: rl } = columns(roster);
    const pfrAt = rh.indexOf("pfr_id");
    const gsisAt = rh.indexOf("gsis_id");

    for (const line of rl) {
      const c = cells(line);

      if (c[pfrAt] && c[gsisAt]) {
        gsisOf.set(c[pfrAt]!, c[gsisAt]!);
      }
    }

    const { head, lines } = columns(snaps);
    const pfr = head.indexOf("pfr_player_id");
    const pct = head.indexOf("offense_pct");
    const tally = new Map<string, { sum: number; n: number; best: number }>();

    for (const line of lines) {
      const c = cells(line);
      const id = gsisOf.get(c[pfr] ?? "");
      const share = Number(c[pct]);

      if (!id || !(share >= 0)) {
        continue;
      }

      const seen = tally.get(id) ?? { sum: 0, n: 0, best: 0 };
      seen.sum += share;
      seen.n++;
      seen.best = Math.max(seen.best, share);
      tally.set(id, seen);
    }

    for (const [id, seen] of tally) {
      out.snapShare.set(id, seen.n > 0 ? seen.sum / seen.n : 0);
      out.bestSnapShare.set(id, seen.best);
    }
  }

  return out;
}

/**
 * Who his club had on reserve when the season opened.
 *
 * This reads the season being predicted rather than the one before it,
 * which is allowed because a drafter knows it too: a man on the reserve
 * or physically-unable-to-perform list in August is public. Only week
 * one is read. Counting reserve weeks across a finished season would be
 * reading the answer.
 */
export async function openedOnReserve(season: number): Promise<Set<string>> {
  const text = await readFile(join(RAW, `roster_weekly_${season}.csv`), "utf8")
    .catch(() => "");
  const out = new Set<string>();

  if (!text) {
    return out;
  }

  const { head, lines } = columns(text);
  const idAt = head.indexOf("gsis_id");
  const statusAt = head.indexOf("status");
  const weekAt = head.indexOf("week");

  for (const line of lines) {
    const c = cells(line);

    if (Number(c[weekAt]) === 1 && c[idAt] && c[statusAt] === "RES") {
      out.add(c[idAt]!);
    }
  }

  return out;
}

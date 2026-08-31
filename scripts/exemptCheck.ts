/**
 * Who cannot play right now, and how much of them is left.
 *
 * No source here carries the commissioner's exempt list. The weekly
 * roster files lag by weeks and spell 2026 exemptions E14, which is the
 * international pathway and not that list. Sleeper does not name it
 * either: a man on it reads DNR with a body part beside it. DNR is the
 * closest proxy for cannot play, and it says nothing about why or for
 * how long, so the shares below are assumptions and are meant to be
 * argued with.
 *
 * Run: npx tsx scripts/exemptCheck.ts
 */

/**
 * How much of a season is left of a man, by why he is out. A knee with
 * surgery behind it is not a hamstring and neither is a suspension, so
 * the body part moves it where the reason alone is too blunt.
 */
export const STILL_WORTH: Record<string, number> = {
  DNR: 0.2, Sus: 0.15, IR: 0.1, NFI: 0.25, PUP: 0.6,
  Inactive: 0.1, "Injured Reserve": 0.1,
  "Physically Unable to Perform": 0.6, "Non Football Injury": 0.25,
};

/** the ones that take a season rather than a month, whatever list he is on */
const LONG_ONES = ["ACL", "Achilles", "Lisfranc", "Torn"];

export function leftOf(
  man: { status?: string | null; injury_status?: string | null;
    injury_body_part?: string | null; injury_notes?: string | null },
): { keeps: number; why: string } {
  const why = STILL_WORTH[man.injury_status ?? ""] !== undefined
    ? man.injury_status!
    : STILL_WORTH[man.status ?? ""] !== undefined
    ? man.status!
    : "";

  if (!why) {
    return { keeps: 1, why: "" };
  }

  const hurt = `${man.injury_body_part ?? ""} ${man.injury_notes ?? ""}`;
  const long = LONG_ONES.some((one) =>
    hurt.toLowerCase().includes(one.toLowerCase()));

  return { keeps: long ? Math.min(STILL_WORTH[why]!, 0.1) : STILL_WORTH[why]!, why };
}

const SCORES = ["QB", "RB", "WR", "TE", "K"];
const players = await fetch("https://api.sleeper.app/v1/players/nfl")
  .then((r) => r.json() as Promise<Record<string, {
    first_name?: string; last_name?: string; position?: string;
    team?: string | null; status?: string | null; injury_status?: string | null;
    injury_body_part?: string | null; injury_notes?: string | null;
    depth_chart_order?: number | null;
  }>>);

const found = Object.values(players)
  .filter((m) => m.team && SCORES.includes(m.position ?? ""))
  .map((m) => ({ m, ...leftOf(m) }))
  .filter((x) => x.keeps < 1 && (x.m.depth_chart_order ?? 9) <= 3)
  .sort((a, b) => a.keeps - b.keeps);

console.log(
  `${found.length} men who start somewhere and cannot play, ` +
  `most missed first:\n`,
);

for (const { m, keeps, why } of found) {
  const hurt = [m.injury_body_part, m.injury_notes].filter(Boolean).join(", ");
  console.log(
    `  ${`${m.first_name} ${m.last_name}`.padEnd(24)}` +
    `${`${m.position} ${m.team}`.padEnd(8)} keeps ${keeps.toFixed(2)}  ` +
    `${why}${hurt ? ` (${hurt})` : ""}`,
  );
}

console.log(
  "\nNobody here is marked exempt, because no source says so. A man on " +
  "that list reads DNR, which is also what a groin reads, so the two " +
  "cannot be told apart from here.",
);

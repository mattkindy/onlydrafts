/**
 * How every team is doing, when the provider says.
 *
 * Sleeper and ESPN both hand back each team's record with the rosters,
 * so nothing extra is fetched for this. A league that says nothing draws
 * no table at all.
 */

import type { League, Roster } from "../lib/providers.ts";

export interface Placed {
  owner: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  /** where the team sits, one being top */
  place: number;
}

/**
 * The table in order: wins first, then points scored, which is how both
 * providers break a tie by default. Every page that says where a team
 * sits reads this, so the league card, the matchup and the table never
 * disagree about who is fourth.
 */
export function placesOf(rosters: Roster[]): Placed[] {
  return rosters
    .filter((r) => r.record)
    .map((r) => ({ owner: r.owner, ...r.record! }))
    .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor)
    .map((row, at) => ({ ...row, place: at + 1 }));
}

/** a record the way people say it, 4-4 or 4-3-1 */
export const recordSays = (row: { wins: number; losses: number; ties: number }) =>
  `${row.wins}-${row.losses}${row.ties ? "-" + row.ties : ""}`;

/** 1st, 2nd, 3rd, 4th, and 11th to 13th, which take th */
export function ordinal(n: number): string {
  const tens = n % 100;

  if (tens >= 11 && tens <= 13) {
    return n + "th";
  }

  return n + (["th", "st", "nd", "rd"][n % 10] ?? "th");
}

/** one team's record and place, said in a few characters, or nothing */
export function standingSays(rosters: Roster[], owner: string): string {
  const row = placesOf(rosters).find((r) => r.owner === owner);

  return row ? `${recordSays(row)} · ${ordinal(row.place)}` : "";
}

export function Standings({ league }: { league: League }) {
  const rows = placesOf(league.allRosters);

  if (rows.length === 0) {
    return null;
  }

  return (
    <>
      <h2>standings</h2>
      <table class="rating standings">
        <thead>
          <tr>
            <th>#</th><th>team</th><th>record</th><th>points for</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.owner} class={row.owner === league.team ? "on" : ""}>
              <td>{row.place}</td>
              <td>{row.owner}</td>
              <td>{recordSays(row)}</td>
              <td>{row.pointsFor.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

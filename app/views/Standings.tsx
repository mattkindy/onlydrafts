/**
 * How every team is doing, when the provider says.
 *
 * Sleeper and ESPN both hand back each team's record with the rosters,
 * so nothing extra is fetched for this. A league that says nothing draws
 * no table at all.
 */

import type { League } from "../lib/providers.ts";

export function Standings({ league }: { league: League }) {
  const rows = league.allRosters
    .filter((r) => r.record)
    .map((r) => ({ owner: r.owner, ...r.record! }))
    .sort((a, b) =>
      b.wins - a.wins || b.pointsFor - a.pointsFor);

  if (rows.length === 0) {
    return null;
  }

  return (
    <>
      <h2>standings</h2>
      <table class="rating">
        <thead>
          <tr>
            <th>#</th><th>team</th><th>record</th><th>points for</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, at) => (
            <tr key={row.owner} class={row.owner === league.team ? "on" : ""}>
              <td>{at + 1}</td>
              <td>{row.owner}</td>
              <td>
                {row.wins}-{row.losses}{row.ties ? "-" + row.ties : ""}
              </td>
              <td>{row.pointsFor.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

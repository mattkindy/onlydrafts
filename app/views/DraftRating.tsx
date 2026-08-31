/** How the draft went, for every team and then pick by pick for yours. */

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import {
  marketCurve, ratePicks, rateTeams, type TeamRating,
} from "../lib/draftRating.ts";
import { asRound } from "../lib/picks.ts";
import { normalizeName } from "../lib/store.ts";
import type { Pick } from "./Draft.tsx";

interface Props {
  board: Player[];
  byKey: Map<string, Player>;
  league: League;
  /** every pick that was made, when the provider could say */
  made: Pick[];
}

/** a grade a person can read, off how far a team beat its own slots */
function gradeOf(over: number, spread: number): string {
  const by = spread > 0 ? over / spread : 0;

  return by > 1.1 ? "A" : by > 0.5 ? "B" : by > -0.5 ? "C" : by > -1.1 ? "D" : "F";
}

function TeamRow(
  { team, at, spread, mine }:
  { team: TeamRating; at: number; spread: number; mine: boolean },
) {
  return (
    <tr class={mine ? "on" : ""}>
      <td>{at}</td>
      <td>{team.owner}</td>
      <td>{gradeOf(team.over, spread)}</td>
      <td>{team.over > 0 ? `+${team.over.toFixed(1)}` : team.over.toFixed(1)}</td>
      <td>{team.got.toFixed(1)}</td>
      <td>{team.expected.toFixed(1)}</td>
      <td>
        {team.starters
          .slice(0, 3)
          .map((s) => s.p.name)
          .join(", ")}
      </td>
    </tr>
  );
}

export function DraftRating(props: Props) {
  const { league, board, byKey } = props;
  const curve = marketCurve(board);
  /**
   * Built from the picks that were made rather than from the rosters,
   * because a roster read afterwards has the free agents somebody took
   * the moment the draft ended, and those were nobody's pick. The
   * rosters are the fallback for a league whose provider cannot say
   * what happened pick by pick.
   */
  const drafted = new Map<string, { men: Player[]; picks: number[] }>();

  for (const pick of props.made) {
    if (pick.keeper) {
      continue;
    }

    const own = drafted.get(pick.who) ?? { men: [], picks: [] };
    const p = byKey.get(normalizeName(pick.name));
    own.picks.push(pick.overall);

    if (p) {
      own.men.push(p);
    }

    drafted.set(pick.who, own);
  }

  const teams = drafted.size > 0
    ? [...drafted.entries()].map(([owner, its]) => ({ owner, ...its }))
    : league.allRosters.map((r) => ({
        owner: r.owner,
        men: r.keys
          .map((m) => byKey.get(m.key))
          .filter((p): p is Player => Boolean(p)),
        picks: r.picks,
      }));
  const rated = rateTeams(teams, league.slots, curve);
  const overs = rated.map((t) => t.over);
  const middle = overs.reduce((a, b) => a + b, 0) / Math.max(1, overs.length);
  const spread = Math.sqrt(
    overs.reduce((sum, v) => sum + (v - middle) ** 2, 0) /
      Math.max(1, overs.length),
  );

  const mine = props.made
    .filter((pick) => pick.mine && !pick.keeper)
    .map((pick) => ({ at: pick.overall, p: byKey.get(normalizeName(pick.name)) }))
    .filter((x): x is { at: number; p: Player } => Boolean(x.p));
  const picks = ratePicks(mine, curve);

  if (rated.length === 0) {
    return (
      <div class="empty">
        No rosters came back from {league.name}, so there is nothing to rate
        yet. Open the league again once the draft has been saved.
      </div>
    );
  }

  return (
    <>
      <div class="empty">
        <b>{rated.length} teams</b> in {league.name}, each against what its own
        picks were worth. A team picking third should come away with more than
        one picking tenth, so only beating your own slots counts.
        {drafted.size > 0
          ? " Only the men who were drafted count, so a free agent taken the moment the draft ended is nobody's pick."
          : " Read off the rosters, since this league cannot say what happened pick by pick."}
      </div>

      <table class="rating">
        <thead>
          <tr>
            <th>#</th><th>team</th><th>grade</th><th>over</th>
            <th>got</th><th>slots worth</th><th>best three</th>
          </tr>
        </thead>
        <tbody>
          {rated.map((team, i) => (
            <TeamRow
              key={team.owner}
              team={team}
              at={i + 1}
              spread={spread}
              mine={team.owner === league.team}
            />
          ))}
        </tbody>
      </table>

      {picks.length > 0 && (
        <>
          <h2>{league.team}, pick by pick</h2>
          <table class="rating">
            <thead>
              <tr>
                <th>pick</th><th>player</th><th>room had him</th>
                <th>waited</th><th>over</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((pick) => (
                <tr key={pick.at}>
                  <td>{asRound(pick.at, league.size)}</td>
                  <td>{pick.p.name} <i>{pick.p.position}</i></td>
                  <td>
                    {pick.adp === null
                      ? "unpriced"
                      : asRound(Math.round(pick.adp), league.size)}
                  </td>
                  <td>
                    {pick.waited === null
                      ? ""
                      : pick.waited > 0
                      ? `${pick.waited.toFixed(0)} late`
                      : `${(-pick.waited).toFixed(0)} early`}
                  </td>
                  <td>
                    {pick.over > 0
                      ? `+${pick.over.toFixed(1)}`
                      : pick.over.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

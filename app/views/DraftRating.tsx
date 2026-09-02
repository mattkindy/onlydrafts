/** How the draft went, for every team and then pick by pick for yours. */

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import {
  gradesFor, keyForPick, marketCurve, ratePicks, rateTeams, type TeamRating,
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

function TeamRow(
  { team, at, grade, mine }:
  { team: TeamRating; at: number; grade: string; mine: boolean },
) {
  return (
    <tr class={mine ? "on" : ""}>
      <td>{at}</td>
      <td>{team.owner}</td>
      <td>{grade}</td>
      {/* a pick leads, since that is what the order and the grade are
          read off. A side with fifteen turns beats one with nine on the
          total without having drafted any better */}
      <td>
        {team.perPick > 0
          ? `+${team.perPick.toFixed(1)}`
          : team.perPick.toFixed(1)}
      </td>
      <td>{team.over > 0 ? `+${team.over.toFixed(1)}` : team.over.toFixed(1)}</td>
      <td>{team.picks}</td>
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
  const drafted = new Map<string, { at: number; p: Player }[]>();

  for (const pick of props.made) {
    if (pick.keeper) {
      continue;
    }

    const p = byKey.get(keyForPick(pick, normalizeName));

    if (p) {
      drafted.set(pick.who, [
        ...(drafted.get(pick.who) ?? []), { at: pick.overall, p },
      ]);
    }
  }

  const teams = drafted.size > 0
    ? [...drafted.entries()].map(([owner, took]) => ({ owner, took }))
    : league.allRosters.map((r) => ({
        owner: r.owner,
        took: r.keys
          .map((m, i) => ({ at: r.picks[i] ?? 999, p: byKey.get(m.key) }))
          .filter((x): x is { at: number; p: Player } => Boolean(x.p)),
      }));
  const rated = rateTeams(teams, league.slots, curve);
  const grades = gradesFor(rated);

  const mine = props.made
    .filter((pick) => pick.mine && !pick.keeper)
    .map((pick) => ({ at: pick.overall, p: byKey.get(keyForPick(pick, normalizeName)) }))
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
            <th>#</th><th>team</th><th>grade</th><th>a pick</th>
            <th>all told</th><th>picks</th>
            <th>got</th><th>slots worth</th><th>best three</th>
          </tr>
        </thead>
        <tbody>
          {rated.map((team, i) => (
            <TeamRow
              key={team.owner}
              team={team}
              at={i + 1}
              grade={grades.get(team.owner) ?? "C"}
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
                    {pick.fell === null
                      ? ""
                      : pick.fell > 0
                      ? `${pick.fell.toFixed(0)} late`
                      : `${(-pick.fell).toFixed(0)} early`}
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

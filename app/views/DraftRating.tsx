/** How the draft went, for every team and then pick by pick for yours. */

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import {
  fillLineup, gradesFor, keyForPick, marketCurve,
} from "../lib/draftRating.ts";
import {
  roomFor, sharePicks, shareTeams, type TeamShare, type Took,
} from "../lib/draftShare.ts";
import { asRound } from "../lib/picks.ts";
import { normalizeName } from "../lib/store.ts";
import type { Pick } from "./Draft.tsx";
import { useMemo } from "preact/hooks";

/** the same draw as the draft board, so a pick reads here as it read there */
const WEEKS_DRAWN = 6000;

interface Props {
  board: Player[];
  byKey: Map<string, Player>;
  league: League;
  /** every pick that was made, when the provider could say */
  made: Pick[];
}

function pct(share: number): string {
  return `${(100 * share).toFixed(0)}%`;
}

function signed(share: number, places = 1): string {
  const text = (100 * share).toFixed(places);

  return share > 0 ? `+${text}` : text;
}

function TeamRow(
  { team, at, grade, mine, starters }:
  {
    team: TeamShare; at: number; grade: string; mine: boolean;
    starters: { p: Player }[];
  },
) {
  return (
    <tr class={mine ? "on" : ""}>
      <td>{at}</td>
      <td>{team.owner}</td>
      <td>{grade}</td>
      <td>{signed(team.over)}</td>
      <td>{pct(team.wins)}</td>
      <td>{pct(team.expected)}</td>
      <td>{team.picks}</td>
      <td>{starters.slice(0, 3).map((s) => s.p.name).join(", ")}</td>
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
  const drafted = new Map<string, Took[]>();
  const kept: Took[] = [];
  /**
   * The picks the board has no man for, so a reader knows a team was
   * rated on fewer picks than it made. Left silent, a side that took a
   * man the board spells differently was rated as if it had skipped
   * the turn.
   */
  const unmatched: Pick[] = [];

  for (const pick of props.made) {
    const p = byKey.get(keyForPick(pick, normalizeName));

    if (!p) {
      unmatched.push(pick);
      continue;
    }

    const one: Took = { at: pick.overall, p, kept: pick.keeper };
    drafted.set(pick.who, [...(drafted.get(pick.who) ?? []), one]);

    if (pick.keeper) {
      kept.push(one);
    }
  }

  const teams = drafted.size > 0
    ? [...drafted.entries()].map(([owner, men]) => ({ owner, took: men }))
    : league.allRosters.map((r) => ({
        owner: r.owner,
        took: r.keys
          .map((m, i) => ({ at: r.picks[i] ?? 999, p: byKey.get(m.key), kept: false }))
          .filter((x): x is Took => Boolean(x.p)),
      }));
  const mine = props.made
    .filter((pick) => pick.mine)
    .map((pick) => ({
      at: pick.overall,
      p: byKey.get(keyForPick(pick, normalizeName)),
      kept: pick.keeper,
    }))
    .filter((x): x is Took => Boolean(x.p));
  /**
   * Drawn once a league, not once a render. Twelve rosters and a
   * replayed draft come to about half a second, which is fine on
   * opening the page and not on every keystroke elsewhere.
   */
  const { rated, picks } = useMemo(() => {
    const room = roomFor(board, league.slots, league.size, WEEKS_DRAWN);
    const everyPick = [...drafted.values()].flat();

    return {
      rated: shareTeams(teams, board, league.slots, room),
      picks: sharePicks(mine, everyPick, board, league.slots, room),
    };
  }, [board, league, props.made]);
  const grades = gradesFor(rated.map((t) => ({ owner: t.owner, perPick: t.over })));
  const startersOf = new Map(teams.map((t) =>
    [t.owner, fillLineup(t.took.map((x) => x.p), league.slots, curve).starters]));

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
        <b>{rated.length} teams</b> in {league.name}, each by how often the
        roster it drafted wins a week against a typical lineup from this room,
        over how often the roster the room would have handed its picks wins.
        A team picking third should come away with more than one picking
        tenth, so only beating your own slots counts.
        {drafted.size > 0
          ? " Only the men who were picked count, so a free agent taken the moment the draft ended is nobody's pick."
          : " Read off the rosters, since this league cannot say what happened pick by pick."}
        {kept.length > 0 && " A keeper counts as a pick at the turn he" +
          " was kept at."}
      </div>

      <table class="rating">
        <thead>
          <tr>
            <th>#</th><th>team</th><th>grade</th><th>over</th>
            <th>wins a week</th><th>slots would</th><th>picks</th>
            <th>best three</th>
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
              starters={startersOf.get(team.owner) ?? []}
            />
          ))}
        </tbody>
      </table>

      {unmatched.length > 0 && (
        <div class="empty">
          <b>{unmatched.length} {unmatched.length === 1 ? "pick" : "picks"}</b>
          {" "}the board has no man for, so {unmatched.length === 1
            ? "that team is"
            : "those teams are"} rated on the rest:{" "}
          {unmatched.map((pick) =>
            `${pick.name} (${pick.position}, ${pick.who}, ${asRound(pick.overall, league.size)})`)
            .join(", ")}.
        </div>
      )}

      {picks.length > 0 && (
        <>
          <h2>{league.team}, pick by pick</h2>
          <div class="empty">
            Each pick as the draft board would have read it at the time, with
            the room's picks up to then off the board: what taking him added
            to how often you win a week, in points of win chance, and who the
            board would have taken instead.
          </div>
          <table class="rating">
            <thead>
              <tr>
                <th>pick</th><th>player</th><th>room had him</th>
                <th>waited</th><th>added</th><th>the board wanted</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((pick) => (
                <tr key={pick.at}>
                  <td>
                    {asRound(pick.at, league.size)}
                    {pick.kept ? <i class="kept"> kept</i> : ""}
                  </td>
                  <td>{pick.p.name} <i>{pick.p.position}</i></td>
                  <td>
                    {pick.p.adp == null
                      ? "unpriced"
                      : asRound(Math.round(pick.p.adp), league.size)}
                  </td>
                  <td>
                    {pick.p.adp == null
                      ? ""
                      : pick.at - pick.p.adp > 0
                      ? `${(pick.at - pick.p.adp).toFixed(0)} late`
                      : `${(pick.p.adp - pick.at).toFixed(0)} early`}
                  </td>
                  <td>{signed(pick.share.added, 2)}</td>
                  <td>
                    {pick.best
                      ? `${pick.best.p.name} ${signed(pick.best.share.added, 2)}`
                      : "him"}
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

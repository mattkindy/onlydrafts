/**
 * Your team, by position, with what each player is projected to do.
 *
 * In a keeper league what he is worth keeping for opens on his own card
 * rather than in a second grid underneath. The two grids listed the same
 * twelve players, so every player on the page appeared twice.
 */

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import { SeasonCard, seasonScale } from "./Card.tsx";
import { KeeperRow, keeperDraft, keeperRounds } from "./Keepers.tsx";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF", "other"];

interface Props {
  byKey: Map<string, Player>;
  /** the whole board, which pricing a keeper against the draft needs */
  players: Player[];
  league: League;
  season: number;
  perTeam: number;
  marked: Record<string, string>;
  /** when the provider was last asked, for the line over the roster */
  readAt?: number | undefined;
  rereading?: boolean;
  onRefresh?: () => void;
  onMark: (p: Player) => void;
  onMore: (p: Player) => void;
  keeperLeague?: boolean;
  /** what keeping a player costs you, said once over the grid */
  keepersSay?: string;
  onKeeperChange?: () => void;
}

export function Roster(props: Props) {
  const { league, marked, players } = props;
  const mine = league.myRoster
    .map((r) => ({ r, p: props.byKey.get(r.key) ?? null }))
    .sort((a, b) => (b.p?.vor ?? -99) - (a.p?.vor ?? -99));
  const kept = Object.keys(marked).filter((k) => marked[k] === league.team).length;
  const max = seasonScale(mine.map((x) => x.p).filter((p): p is Player => Boolean(p)));
  const draft = props.keeperLeague
    ? keeperDraft(league, props.byKey, props.perTeam)
    : null;
  const rounds = draft ? keeperRounds(players, mine, draft) : new Map<string, number>();

  const byPosition = new Map<string, typeof mine>();

  for (const entry of mine) {
    const position = entry.p?.position ?? "other";
    byPosition.set(position, [...(byPosition.get(position) ?? []), entry]);
  }

  return (
    <>
      <div class="rosterhead">
        <b>{league.team}</b>
        <span>{props.readAt === undefined ? "" : rosterRead(props.readAt)}</span>
        {props.onRefresh && (
          <button
            class="quiet"
            disabled={props.rereading}
            onClick={props.onRefresh}
          >
            {props.rereading ? "refreshing..." : "refresh"}
          </button>
        )}
      </div>

      <div class="empty">
        <b>{mine.length} players</b> on {league.team} in {league.name}
        {kept
          ? `, ${kept} marked as keepers`
          : ", none marked as keepers yet"}
      </div>

      {props.keeperLeague && props.keepersSay && (
        <p class="hint">{props.keepersSay}</p>
      )}

      {POSITIONS.filter((where) => byPosition.has(where)).map((where) => (
        <div key={where}>
          <h2>{where}</h2>
          <div class="cards">
            {byPosition.get(where)!.map(({ r, p }) => {
              if (!p) {
                return (
                  <div class="card plain" key={r.key}>
                    <div class="nm"><span class="who">{r.name}</span></div>
                    <div class="sub">
                      {/* he is on last season's roster and nobody has
                          signed him for this one */}
                      <span>no NFL team for {props.season}, so no projection</span>
                    </div>
                  </div>
                );
              }

              const isKept = Boolean(marked[p.key]);

              return (
                <SeasonCard
                  key={p.key}
                  p={p}
                  max={max}
                  slim
                  teams={props.league.size || 12}
                  kept={isKept}
                  badge={isKept ? "keeper" : ""}
                  onMore={() => props.onMore(p)}
                >
                  {draft && (
                    <KeeperRow
                      players={players}
                      p={p}
                      league={league}
                      perTeam={props.perTeam}
                      round={rounds.get(p.key) ?? null}
                      kept={isKept}
                      onMark={() => props.onMark(p)}
                      onChange={props.onKeeperChange ?? (() => {})}
                    />
                  )}
                </SeasonCard>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/** how fresh the roster is, in the words somebody checking would use */
export function rosterRead(readAt: number): string {
  if (!readAt) {
    return "read, but the page did not note when";
  }

  const mins = Math.floor((Date.now() - readAt) / 60000);

  if (mins < 1) {
    return "roster read just now";
  }

  if (mins < 60) {
    return `roster read ${mins} min ago`;
  }

  return "roster read at " + new Date(readAt)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

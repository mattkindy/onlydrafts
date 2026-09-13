/**
 * What each player on your roster is worth keeping for.
 *
 * The question is a trade every time: his value over a season against
 * what the pick he costs would have bought instead, less what waiting
 * and drafting him anyway would have gained.
 */

import { useState } from "preact/hooks";

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import {
  CLOSE_SEASON, asRound, keeperSums, optionsAt, pickForRound, stillThereAt,
  type Chance, type Draft,
} from "../lib/picks.ts";
import {
  betterLater, keeperCosts, likelyKept, markedKeepers,
  saveKeeperCost, worthUpToEach, type Beaten,
} from "../lib/keepers.ts";
import { ordinal } from "./Card.tsx";

function Figures(
  { players, p, costPick, draft, teams }:
  { players: Player[]; p: Player; costPick: number; draft: Draft; teams: number },
) {
  const { best, rate, roi, wait, net, makesItUp } =
    keeperSums(players, p, costPick, draft);
  const cell = (label: string, value: number, how: string, tip: string) => (
    <span class={"fig " + how} title={tip} key={label}>
      <i>{label}</i>
      {value > 0 && how ? "+" : ""}{value.toFixed(0)}
    </span>
  );

  return (
    <div class="figures">
      {cell("he is worth", p.vor ?? 0, "",
        "his VOR (value over replacement): what he is worth over a season " +
        "above a replacement-level player at his position")}
      {cell(asRound(costPick, teams) + " buys", rate, "",
        "what the best player left on the board is worth there, with every " +
        "candidate weighed by how often he lasts that long" +
        (best ? ". Today that is usually " + best.name : ""))}
      {cell("keeping gains", roi, roi >= 0 ? "up" : "down",
        "his value less what that pick would have bought instead")}
      {wait.atPick && wait.chance > 0.1 && wait.chance < 0.98 &&
        cell("waiting gains", wait.gain, "",
          "let him go and he is still on the board at your " +
          asRound(wait.atPick, teams) + " pick " +
          Math.round(100 * wait.chance) +
          "% of the time, so you might have him and the pick both")}
      {cell("worth keeping", net, net >= 0 ? "up" : "down",
        "what keeping gains, less what waiting for him would have " +
        "gained. Above zero, keep him")}
      {makesItUp.length > 0 && (
        <div class="madeof">
          <i>{asRound(costPick, teams)} lands on</i>{" "}
          {makesItUp.map((o: Chance, i) => (
            <span key={o.who.key}>
              {i > 0 && ", "}{o.who.name} <b>{Math.round(100 * o.odds)}%</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Who else that pick could buy. The players at his own position are the
 * swap a drafter pictures; the rest are there because a pick spent on
 * him is a pick not spent on a tight end either. Both compare on value
 * over the last player the league would start at that position, which is
 * the only way a quarterback and a receiver sit side by side.
 */
function Instead(
  { players, p, costPick, draft, teams }:
  { players: Player[]; p: Player; costPick: number; draft: Draft; teams: number },
) {
  const ranks = (title: string, who: Player[]) => {
    if (!who.length) {
      return <div class="hint">nobody {title}</div>;
    }

    return (
      <div class="scroll">
        <table class="ranks">
          <thead>
            <tr>
              <th>{title}</th>
              <th>adp</th>
              <th title="how often he is still on the board at this pick">there</th>
              <th title="fantasy points in a typical game">pts/g</th>
              <th title="VOR (value over replacement): what he is worth over a season above a replacement-level player at his position. Positions only compare this way">vor</th>
              <th title="his value less the keeper's, over a season">vs him</th>
            </tr>
          </thead>
          <tbody>
            {who.map((o) => {
              const gap = (o.vor ?? 0) - (p.vor ?? 0);
              const odds = stillThereAt(o, costPick);

              return (
                <tr key={o.key}>
                  <td>{o.name} <span class="pos">{o.position}</span></td>
                  <td class="n">{asRound(o.adpRank ?? o.adp ?? 0, teams)}</td>
                  <td class={"n " + (odds >= 0.7 ? "up" : odds >= 0.3 ? "" : "down")}>
                    {Math.round(100 * odds)}%
                  </td>
                  <td class="n">{(o.ppg ?? 0).toFixed(1)}</td>
                  <td class="n">{(o.vor ?? 0).toFixed(0)}</td>
                  <td class={"n " + (gap > 0 ? "down" : "up")}>
                    {gap > 0 ? "+" : ""}{gap.toFixed(0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };
  const anybody = optionsAt(players, costPick, draft, p.key, null, 10)
    .filter((o) => o.position !== p.position)
    .slice(0, 3);

  return (
    <div class="instead">
      {ranks(
        `other ${p.position}s near ${asRound(costPick, teams)}`,
        optionsAt(players, costPick, draft, p.key, p.position, 5),
      )}
      {anybody.length > 0 && (
        <div class="alsoat">{ranks("anyone else there", anybody)}</div>
      )}
    </div>
  );
}

function Beat({ beaten, costPick, teams }: {
  beaten: Beaten[]; costPick: number; teams: number;
}) {
  if (!beaten.length) {
    return null;
  }

  return (
    <div class="beaten">
      <i>better and likely there at {asRound(costPick, teams)}</i>
      {beaten.map((o) => (
        <span class="f" key={o.who.key}>
          <b>{o.who.name}</b> +{o.better.toFixed(0)} &middot;{" "}
          {Math.round(100 * o.odds)}%
        </span>
      ))}
    </div>
  );
}

/**
 * The draft a keeper is priced against: your own turns, and everybody
 * already spoken for.
 *
 * Your own marks, plus the players every other team is likely to keep.
 * Everyone else on a roster goes back into the draft, so treating a whole
 * roster as unavailable would empty the board.
 */
export function keeperDraft(
  league: League, byKey: Map<string, Player>, perTeam: number,
): Draft {
  return {
    teams: league.size || 12,
    slot: league.draftSlot,
    snake: league.snake,
    myRounds: league.myPicks.length ? league.myPicks : null,
    taken: new Set([
      ...Object.keys(markedKeepers(league.leagueId)),
      ...likelyKept(league, byKey, perTeam),
    ]),
  };
}

/** the earliest pick each of your players still beats, by his key */
export function keeperRounds(
  players: Player[],
  mine: { p: Player | null }[],
  draft: Draft,
): Map<string, number> {
  const onRoster = mine
    .map((x) => x.p)
    .filter((p): p is Player => Boolean(p));

  return new Map(
    worthUpToEach(players, onRoster, draft).map(({ p, round }) => [p.key, round]),
  );
}

/** what the pick he costs would buy instead, and who beats him there */
function KeeperDetail(
  { players, p, costPick, draft, teams }:
  { players: Player[]; p: Player; costPick: number; draft: Draft; teams: number },
) {
  return (
    <>
      <Figures
        players={players} p={p} costPick={costPick} draft={draft} teams={teams}
      />
      <Beat
        beaten={betterLater(players, p, costPick, draft.taken)}
        costPick={costPick}
        teams={teams}
      />
      <Instead
        players={players} p={p} costPick={costPick} draft={draft} teams={teams}
      />
    </>
  );
}

/**
 * The draft with this player back on the board: he is the one being
 * priced, so he cannot also be taken.
 */
function pricedAgainst(draft: Draft, p: Player, also?: Iterable<string>): Draft {
  const taken = new Set([...draft.taken, ...(also ?? [])]);
  taken.delete(p.key);

  return { ...draft, taken };
}

/** keep him, let him go, or too close to call */
function keeperCall(net: number) {
  if (net > CLOSE_SEASON) {
    return { word: "keep", how: "up" };
  }

  if (net < -CLOSE_SEASON) {
    return { word: "let go", how: "down" };
  }

  return { word: "close", how: "even" };
}

/**
 * One line at the foot of a roster card: what the league charges for
 * him, whether to keep him, and the mark that says you are.
 */
export function KeeperRow(
  { players, p, league, perTeam, round, kept, onMark, onChange }: {
    players: Player[];
    p: Player;
    league: League;
    perTeam: number;
    /** the earliest pick he still beats */
    round: number | null;
    kept: boolean;
    onMark: () => void;
    onChange: () => void;
  },
) {
  const [open, setOpen] = useState(false);
  const teams = league.size || 12;
  const cost = Number(keeperCosts(league.leagueId)[p.key]) || 0;
  const draft = keeperDraft(
    league, new Map(players.map((one) => [one.key, one])), perTeam);
  const costPick = cost ? pickForRound(cost, draft) : null;
  const mineToo = pricedAgainst(draft, p);
  const sums = costPick ? keeperSums(players, p, costPick, mineToo) : null;
  const call = sums ? keeperCall(sums.net) : null;
  const why = call?.how === "down"
    ? `a ${ordinal(cost)} buys more`
    : round
      ? `worth a ${ordinal(round)}`
      : "";

  return (
    <div class="keeprow">
      <CostRow
        p={p}
        cost={cost}
        leagueId={league.leagueId}
        onChange={onChange}
      />
      <button
        class={"verdict " + (call?.how ?? "")}
        aria-expanded={open}
        disabled={!costPick}
        onClick={(e) => { e.stopPropagation(); setOpen((on) => !on); }}
      >
        {call ? <b>{call.word}</b> : null}
        {why ? <i>{why}</i> : null}
      </button>
      <button
        class={"keepbtn" + (kept ? " on" : "")}
        aria-pressed={kept}
        onClick={(e) => { e.stopPropagation(); onMark(); }}
      >
        {kept ? "kept" : "keep"}
      </button>
      {open && costPick && (
        <div class="keeperfold">
          <KeeperDetail
            players={players} p={p} costPick={costPick}
            draft={mineToo} teams={teams}
          />
        </div>
      )}
    </div>
  );
}

/** what the league charges for him, which you can correct */
function CostRow({ p, cost, leagueId, onChange }: {
  p: Player; cost: number; leagueId: string;
  onChange: () => void;
}) {
  return (
    <label class="costrow">
      <i>costs</i>
      <input
        type="number" min="1" max="15" placeholder="?"
        value={cost || ""}
        onChange={(e) => {
          saveKeeperCost(leagueId, p.key, Number(e.currentTarget.value));
          onChange();
        }}
      />
      <b>rd</b>
    </label>
  );
}

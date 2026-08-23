/**
 * What each man on your roster is worth keeping for.
 *
 * The question is a trade every time: his value over a season against
 * what the pick he costs would have bought instead, less what waiting
 * and drafting him anyway would have gained.
 */

import type { Player } from "../lib/scoring.ts";
import type { League } from "../lib/providers.ts";
import {
  CLOSE_SEASON, asRound, keeperSums, optionsAt, pickForRound, stillThereAt,
  type Chance, type Draft,
} from "../lib/picks.ts";
import {
  adpOverrides, betterLater, keeperCosts, likelyKept, markedKeepers,
  saveAdpAt, saveKeeperCost, whoToKeep, worthUpToEach, type Beaten,
} from "../lib/keepers.ts";
import { SeasonCard, ordinal, seasonScale } from "./Card.tsx";

interface Props {
  men: Player[];
  byKey: Map<string, Player>;
  league: League;
  perTeam: number;
  onMore: (p: Player) => void;
  onChange: () => void;
}

function Figures(
  { men, p, costPick, draft, teams }:
  { men: Player[]; p: Player; costPick: number; draft: Draft; teams: number },
) {
  const { best, rate, roi, wait, net, makesItUp } =
    keeperSums(men, p, costPick, draft);
  const cell = (label: string, value: number, how: string, tip: string) => (
    <span class={"fig " + how} title={tip} key={label}>
      <i>{label}</i>
      {value > 0 && how ? "+" : ""}{value.toFixed(0)}
    </span>
  );

  return (
    <div class="figures">
      {cell("he is worth", p.vor ?? 0, "",
        "what his place on our board is worth over a season, above the " +
        "last man this league starts at his position")}
      {cell(asRound(costPick, teams) + " buys", rate, "",
        "what the best man still on the board is worth there, with every " +
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
 * Who else that pick could buy. The men at his own position are the
 * swap a drafter pictures; the rest are there because a pick spent on
 * him is a pick not spent on a tight end either. Both compare on value
 * over the last man the league would start at that position, which is
 * the only way a quarterback and a receiver sit side by side.
 */
function Instead(
  { men, p, costPick, draft, teams }:
  { men: Player[]; p: Player; costPick: number; draft: Draft; teams: number },
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
              <th title="what a man in his place on our board is worth over a season, above the last one this league starts at his position. Positions only compare this way">vor</th>
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
  const anybody = optionsAt(men, costPick, draft, p.key, null, 10)
    .filter((o) => o.position !== p.position)
    .slice(0, 3);

  return (
    <div class="instead">
      {ranks(
        `other ${p.position}s near ${asRound(costPick, teams)}`,
        optionsAt(men, costPick, draft, p.key, p.position, 5),
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

export function Keepers(props: Props) {
  const { men, byKey, league, perTeam } = props;
  const teams = league.size || 12;
  const costs = keeperCosts(league.leagueId);
  const draft: Draft = {
    teams,
    slot: league.draftSlot,
    snake: league.snake,
    myRounds: league.myPicks.length ? league.myPicks : null,
    // Your own marks, plus the men every other team is likely to keep.
    // Everyone else on a roster goes back into the draft, so treating a
    // whole roster as unavailable would empty the board.
    taken: new Set([
      ...Object.keys(markedKeepers(league.leagueId)),
      ...likelyKept(league, byKey, perTeam),
    ]),
  };
  const onRoster = league.myRoster
    .map((r) => byKey.get(r.key))
    .filter((p): p is Player => Boolean(p));
  const keeping = whoToKeep(
    men, onRoster, costs, draft, perTeam,
    league.myPicks.length ? league.myPicks : null,
  );
  const mine = worthUpToEach(men, onRoster, draft);
  const max = seasonScale(onRoster);

  return (
    <>
      <div class="empty">
        <b>What each man is worth keeping for.</b> Round shown is the
        earliest pick he still beats. Type what your league charges and
        the card says whether to keep him.
        <br />
        Assuming every other team keeps its {perTeam} best it can pay
        for, which takes {draft.taken.size} players out of the draft.
        {league.myPicks.length > 0 && (
          <>
            <br />
            You pick {league.draftSlot ? ordinal(league.draftSlot) + " and " : ""}
            have rounds {league.myPicks.join(", ")}.
          </>
        )}
      </div>

      <div class="cards wide">
        {mine.map(({ p, round }) => {
          const cost = Number(costs[p.key]) || 0;
          const costPick = cost ? pickForRound(cost, draft) : null;
          const holdsIt = !cost || !league.myPicks.length ||
            league.myPicks.includes(cost);
          /**
           * Your own keepers are off the board as well. Weighing one
           * against a pick that might buy Brock Purdy is wrong when
           * Purdy is a man you are keeping.
           */
          const mineToo: Draft = {
            ...draft,
            taken: new Set([...draft.taken, ...keeping]),
          };
          mineToo.taken.delete(p.key);
          const sums = costPick
            ? keeperSums(men, p, costPick, mineToo)
            : null;
          // the chip says what the net says, so the card cannot argue
          // with itself the way it did when the two were worked out apart
          const call = !sums ? null
            : sums.net > CLOSE_SEASON ? { word: "keep", how: "up" }
            : sums.net < -CLOSE_SEASON ? { word: "let go", how: "down" }
            : { word: "close", how: "even" };

          return (
            <SeasonCard
              key={p.key}
              p={p}
              max={max}
              teams={teams}
              costs={cost || null}
              aside={{ label: "worth a", value: ordinal(round) }}
              badge={call?.word ?? ""}
              badgeHow={call?.how ?? ""}
              tag={holdsIt
                ? ""
                : `you traded your ${ordinal(cost)}, so you cannot keep him`}
              warn={!holdsIt}
              onMore={() => props.onMore(p)}
            >
              <CostRow
                p={p}
                cost={cost}
                leagueId={league.leagueId}
                onChange={props.onChange}
              />
              {costPick && (
                <>
                  <Figures
                    men={men} p={p} costPick={costPick}
                    draft={mineToo} teams={teams}
                  />
                  <Beat
                    beaten={betterLater(men, p, costPick, mineToo.taken)}
                    costPick={costPick}
                    teams={teams}
                  />
                  <Instead
                    men={men} p={p} costPick={costPick}
                    draft={mineToo} teams={teams}
                  />
                </>
              )}
            </SeasonCard>
          );
        })}
      </div>
    </>
  );
}

/** what the league charges for him, which you can correct */
function CostRow({ p, cost, leagueId, onChange }: {
  p: Player; cost: number; leagueId: string; onChange: () => void;
}) {
  const yours = keeperCosts(leagueId)[p.key];
  const goesAt = adpOverrides(leagueId)[p.key];

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
      {yours ? <span class="chip up">yours</span> : null}
      {goesAt ? <span class="chip">goes at {Math.round(goesAt)}</span> : null}
    </label>
  );
}

export { saveAdpAt };

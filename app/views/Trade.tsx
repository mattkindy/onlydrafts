/**
 * Weigh a trade: choose who you deal with, tick what each side sends,
 * players and draft picks, and see what it does to both teams.
 *
 * The verdict is the rest of the season played out twice, as it stands
 * and with the two rosters swapped, on the same draws so the difference
 * is the trade and not the dice: the regular season week by week with
 * whoever is fit for each week, then the playoffs, so a starter back from
 * reserve in December is worth what he is worth in December. Beside it,
 * each side's best weekly lineup, what the players are worth for the rest
 * of the season, and the picks, which are what a team giving up on this
 * season is buying.
 *
 * Which of those matters depends on where a team stands. A contender is
 * buying a title and a team out of the race is buying next year, so the
 * same trade reads one way to one and the other way to the other. A
 * league where nothing carries over has no next year to buy. Where
 * players carry over, a player is worth his next seasons as well: all of
 * them in a dynasty league, and in a keeper league next season's, over
 * what he costs to keep, if he is one of the few his team would keep.
 *
 * Both sides are shown because a trade the other manager loses is a trade
 * nobody accepts, and finding one that helps you both is the job.
 */

import { useMemo, useState } from "preact/hooks";

import type { Listed } from "../lib/availability.ts";
import { readRules, rulesKey } from "../lib/playoffRules.ts";
import type { DraftPick, League } from "../lib/providers.ts";
import type { Player } from "../lib/scoring.ts";
import { SEASON_WEEKS } from "../lib/availability.ts";
import {
  playoffOdds, playoffRounds, type PlayoffOdds, type Strength,
} from "../lib/seasonStats.ts";
import {
  HOW_ODDS_WORK, HOW_ODDS_WORK_IN_FULL, splitAtPlayoffs, useSeasonSim, weeklyStrengths,
} from "../lib/seasonSim.ts";
import { keeperCosts } from "../lib/keepers.ts";
import { keep, stored } from "../lib/store.ts";
import {
  dealIsEmpty, draftCurve, dynastyValue, keeperGain, keptValue, NO_DEAL, overallPick,
  overTheLimit, pickId, pickValue, restOfSeason, rostersAfter, SEASON_OUT, SEASONS_AHEAD,
  slotsFromWins, stageOf, tradeVerdict, valueSays, type Deal,
} from "../lib/trade.ts";
import { ordinal } from "./Standings.tsx";

/** how often each version of the season is played out, as the stats tab does */
const SEASONS = 5000;

interface Props {
  league: League;
  players: Player[];
  /** the week coming up */
  coming: number;
  listed: Map<string, Listed>;
  /** opens the league's settings, where a deadline nobody has said can be set */
  onSettings?: () => void;
  /** whether the league keeps players, as the page has it */
  keeperLeague?: boolean;
  /** how many each team keeps there */
  perTeam?: number;
}

const signed = (n: number, places = 0) =>
  (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toFixed(places);

const pctOf = (share: number) =>
  share >= 0.995 ? ">99%" : share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;

/** a pick as a manager says it: "2027 1st", with whose it was where that matters */
const pickSays = (p: DraftPick, holder: string) =>
  `${p.season} ${ordinal(p.round)}` + (p.from !== holder ? ` (${p.from})` : "");

export function Trade(props: Props) {
  const { league, players, coming, listed } = props;
  const sim = useSeasonSim({ league, players, coming, listed });
  const others = league.allRosters.filter((r) => r.owner !== league.team);
  const partnerKey = `tradePartner:${league.provider}:${league.leagueId}`;
  const [deal, setDeal] = useState<Deal>(() => {
    const last = stored<string>(partnerKey, "");

    return NO_DEAL(others.some((r) => r.owner === last) ? last : others[0]?.owner ?? "");
  });
  const choosePartner = (owner: string) => {
    keep(partnerKey, owner);
    setDeal(NO_DEAL(owner));
  };
  const [shown, setShown] = useState<"send" | "get">("send");
  const toggle = (list: keyof Omit<Deal, "partner">, id: string) =>
    setDeal((d) => ({
      ...d, [list]: d[list].includes(id) ? d[list].filter((x) => x !== id) : [...d[list], id],
    }));

  const lastRegular = league.lastRegularWeek ?? 14;
  const rules = useMemo(() => readRules(stored(rulesKey(league), null), league), [league]);
  const rounds = playoffRounds(rules.teams);
  // a player is worth the weeks left to the final, the playoffs included
  const weeksLeft = Math.max(0, Math.min(SEASON_WEEKS, lastRegular + rounds) - coming + 1);
  const divisionOf = useMemo(() => new Map(league.allRosters
    .filter((r) => typeof r.division === "number")
    .map((r) => [r.owner, r.division!])), [league]);

  const playOut = (weekly: Map<string, Strength>[]) => sim.setup
    ? playoffOdds({
        table: sim.setup.table,
        weeks: sim.setup.toCome,
        strength: sim.strength,
        ...splitAtPlayoffs(weekly, coming, lastRegular, rounds),
        playoffTeams: rules.teams,
        rules,
        divisionOf,
        mine: league.team,
        draws: SEASONS,
      }).odds
    : null;

  const before = useMemo(
    () => playOut(sim.weekly), [sim.setup, sim.weekly, rules, divisionOf, rounds]);
  const dealKey = JSON.stringify(deal);
  const afterWeekly = useMemo(() => weeklyStrengths({
    rosters: rostersAfter(league, deal),
    slots: league.slots,
    byKey: sim.byKey,
    listed,
    season: sim.season,
    weeks: sim.weekly.length,
    scaleFrom: league.allRosters,
  }), [dealKey, league, sim.byKey, sim.season, sim.weekly.length, listed]);
  const after = useMemo(
    () => (dealIsEmpty(deal) ? before : playOut(afterWeekly)),
    [dealKey, afterWeekly, before],
  );

  // where each team's pick falls in the coming draft: the fewest wins first
  const slots = useMemo(() => slotsFromWins(
    before?.map((o) => ({ owner: o.owner, wins: o.wins })) ??
      league.allRosters.map((r) => ({ owner: r.owner, wins: r.record?.wins ?? 0 }))),
  [before, league]);
  const curve = useMemo(() => draftCurve(players), [players]);
  const picks = league.picks ?? [];
  const valueOfPick = (p: DraftPick) => pickValue(p, {
    curve, teams: league.size || 12, snake: league.snake, season: league.season,
    slotOf: (owner) => slots.get(owner) ?? null,
  });
  const valueOf = (key: string) => restOfSeason(sim.byKey.get(key), weeksLeft);

  // what outlives this season: every player in a dynasty league, the few
  // each team keeps in a keeper league, nobody in a redraft one
  const carries = league.dynasty ? "dynasty" : props.keeperLeague ? "keeper" : null;
  const perTeam = props.perTeam ?? 3;
  const costs = useMemo(() => keeperCosts(league.leagueId), [league.leagueId]);
  const teams = league.size || 12;
  // a keeper costs the pick in the round he is kept for, at the middle of it
  const costOf = (key: string) => {
    const round = Number(costs[key]) || 0;

    return round ? curve(overallPick(round, Math.ceil(teams / 2), teams, league.snake)) : 0;
  };
  const laterOf = (key: string): number | null => {
    const p = sim.byKey.get(key);

    return carries === "dynasty"
      ? dynastyValue(p)
      : carries === "keeper" ? keeperGain(p, costOf(key)) : null;
  };
  // whether the board projects anyone's next seasons yet
  const boardLooksAhead = useMemo(() => players.some((p) => p.ahead?.length), [players]);

  const partner = league.allRosters.find((r) => r.owner === deal.partner);
  const mine = league.allRosters.find((r) => r.owner === league.team);

  if (!partner || !mine) {
    return <p class="hint">No other team in this league to trade with.</p>;
  }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const pickById = new Map(picks.map((p) => [pickId(p), p]));
  const giveNow = sum(deal.give.map(valueOf));
  const getNow = sum(deal.get.map(valueOf));
  const givePicks = sum(deal.givePicks.map((id) => valueOfPick(pickById.get(id)!)));
  const getPicks = sum(deal.getPicks.map((id) => valueOfPick(pickById.get(id)!)));
  const oddsOf = (odds: PlayoffOdds[] | null, owner: string) =>
    odds?.find((o) => o.owner === owner) ?? null;
  const { byWeek: regularBefore, bracket: playoffsBefore } =
    splitAtPlayoffs(sim.weekly, coming, lastRegular, rounds);
  const { byWeek: regularAfter, bracket: playoffsAfter } =
    splitAtPlayoffs(afterWeekly, coming, lastRegular, rounds);
  // a team's points a week over some weeks, as its lineups stand in them
  const lineupOf = (weeks: Map<string, Strength>[], owner: string) =>
    weeks.length ? weeks.reduce((sum, w) => sum + (w.get(owner)?.mean ?? 0), 0) / weeks.length : 0;
  const deadline = league.tradeDeadline ?? null;
  const closed = deadline !== null && coming > deadline;

  // what a side's players are worth past this season, after the trade
  // against before: in a keeper league its best few keepers, before and
  // after, since a player it would not keep is worth nothing to it then
  const laterFor = (owner: string, give: boolean) => {
    if (!carries || !boardLooksAhead) {
      return 0;
    }

    if (carries === "dynasty") {
      const worth = (keys: string[]) => sum(keys.map((k) => laterOf(k) ?? 0));

      return give ? worth(deal.get) - worth(deal.give) : worth(deal.give) - worth(deal.get);
    }

    const kept = (keys: { key: string }[]) =>
      keptValue(keys.map((p) => laterOf(p.key) ?? 0), perTeam);
    const was = league.allRosters.find((r) => r.owner === owner)?.keys ?? [];
    const will = rostersAfter(league, deal).find((r) => r.owner === owner)?.keys ?? [];

    return kept(will) - kept(was);
  };

  const side = (owner: string, give: boolean) => {
    const was = oddsOf(before, owner);
    const will = oddsOf(after, owner);
    const now = { before: was?.playoffs ?? null, after: will?.playoffs ?? null };
    const title = { before: was?.champion ?? null, after: will?.champion ?? null };
    const lineup = lineupOf(regularAfter, owner) - lineupOf(regularBefore, owner);
    const playoffLineup = lineupOf(playoffsAfter, owner) - lineupOf(playoffsBefore, owner);
    const players = give ? getNow - giveNow : giveNow - getNow;
    const future = give ? getPicks - givePicks : givePicks - getPicks;
    const drop = overTheLimit(league, deal, give ? "mine" : "theirs");
    const stage = was ? stageOf(was.playoffs) : null;
    const later = laterFor(owner, give);

    return { now, title, lineup, playoffLineup, players, future, later, drop, stage };
  };
  const you = side(league.team, true);
  const them = side(deal.partner, false);
  // the change as the two rounded figures beside it say it, so 22% → 27% reads +5
  const change = (odds: { before: number | null; after: number | null }) =>
    odds.before !== null && odds.after !== null
      ? (Math.round(odds.after * 100) - Math.round(odds.before * 100)) / 100
      : null;
  // what a trade does to a side this season: the title where the playoffs
  // are played out, the race to them where the title does not move
  const nowOf = (s: typeof you) => {
    const title = change(s.title);
    const race = change(s.now);

    return title !== null && title !== 0 ? title : race;
  };
  const verdict = (() => {
    const a = nowOf(you);
    const b = nowOf(them);

    return a === null || b === null || dealIsEmpty(deal)
      ? null
      : tradeVerdict({ now: a, theirs: b, later: you.future + you.later, stage: you.stage });
  })();
  // whether anything a trade buys outlives this season: picks, or a
  // league that keeps its players
  const hasLater = carries !== null || (league.picks?.length ?? 0) > 0;
  const anyPlayers = deal.give.length + deal.get.length > 0;
  const laterSays = carries === "dynasty"
    ? "later seasons"
    : `keepers`;
  const laterTip = carries === "dynasty"
    ? `what the players are worth over their next ${SEASONS_AHEAD} seasons, in points over a replacement, a season further off worth ${SEASON_OUT} of the one before`
    : `next season, what the team's best ${perTeam} keepers gain over the picks they cost, after the trade against before`;
  const openWeeks = deadline !== null && !closed ? deadline - coming + 1 : null;
  const regularLeft = Math.max(0, lastRegular - coming + 1);
  const hasPicks = picks.length > 0;
  const anyPicks = deal.givePicks.length + deal.getPicks.length > 0;

  return (
    <div class="trade rhythm">
      <div class="tpartner">
        <span class="tlabel">trade with</span>
        <div class="chips" role="tablist">
          {others.map((r) => {
            // each team's chance of the playoffs, since a team out of the
            // race is the one selling
            const odds = oddsOf(before, r.owner)?.playoffs;

            return (
              <button
                key={r.owner}
                role="tab"
                aria-selected={r.owner === deal.partner}
                class={r.owner === deal.partner ? "on" : ""}
                title={odds === undefined ? undefined : `${pctOf(odds)} to make the playoffs`}
                onClick={() => choosePartner(r.owner)}
              >
                {r.owner}
                {odds !== undefined && <small class="todds">{pctOf(odds)}</small>}
              </button>
            );
          })}
        </div>
      </div>

      {closed && (
        <p class="hint warn">The trade deadline was week {deadline}, so this is a what-if.</p>
      )}
      {league.tradeDeadline === undefined && props.onSettings && (
        <p class="hint">
          The league doesn't say when trades close.{" "}
          <button class="textbtn" onClick={props.onSettings}>set the deadline</button>
        </p>
      )}

      <div class={"tresult" + (dealIsEmpty(deal) ? " idle" : "")}>
        {dealIsEmpty(deal)
          ? <p class="hint">Tick players or picks on either side to weigh a trade.</p>
          : (
            <>
              <div class="tsum">
                <span><i>you send</i>{[
                  ...deal.give.map((k) => sim.byKey.get(k)?.name ?? mine.keys.find((p) => p.key === k)?.name ?? k),
                  ...deal.givePicks.map((id) => pickSays(pickById.get(id)!, league.team)),
                ].join(", ") || "nothing"}</span>
                <span><i>you get</i>{[
                  ...deal.get.map((k) => sim.byKey.get(k)?.name ?? partner.keys.find((p) => p.key === k)?.name ?? k),
                  ...deal.getPicks.map((id) => pickSays(pickById.get(id)!, deal.partner)),
                ].join(", ") || "nothing"}</span>
                {verdict && <b class={"tverdict " + verdict.tone}>{verdict.says}</b>}
              </div>
              <p class="twindow">
                {you.stage && <span><i>you</i>{you.stage}</span>}
                {them.stage && <span><i>{deal.partner}</i>{them.stage}</span>}
                <span>
                  <i>left</i>
                  {regularLeft ? `${regularLeft} wk${regularLeft === 1 ? "" : "s"} + playoffs` : "playoffs"}
                </span>
                {openWeeks !== null && (
                  <span class={openWeeks <= 1 ? "soon" : ""}>
                    <i>deadline</i>{openWeeks <= 1 ? "this week" : `wk ${deadline}`}
                  </span>
                )}
                {!hasLater && <span><i>after</i>nothing carries over</span>}
              </p>
              <table class="tgrid">
                <thead>
                  <tr><th /><th>you</th><th>{deal.partner}</th></tr>
                </thead>
                <tbody>
                  {sim.setup && you.title.before !== null && (
                    <OddsRow
                      label="title"
                      says="how often the team wins the playoffs, the rest of the season and the bracket played out 5,000 times"
                      sides={[you.title, them.title]}
                    />
                  )}
                  {sim.setup && (
                    <OddsRow
                      label="playoffs"
                      says="how often the team makes the playoffs, the rest of the season played out 5,000 times"
                      sides={[you.now, them.now]}
                    />
                  )}
                  {regularLeft > 0 && (
                    <tr>
                      <th title="points a week from the best lineup the roster can start, over the regular season left, with whoever is fit each week">lineup / wk</th>
                      {[you, them].map((s, i) => (
                        <td key={i} class={s.lineup > 0.05 ? "up" : s.lineup < -0.05 ? "down" : ""}>
                          {signed(s.lineup, 1)}
                        </td>
                      ))}
                    </tr>
                  )}
                  {playoffsBefore.length > 0 && (
                    <tr>
                      <th title="points a week from the best lineup the roster can start in the playoff weeks, a player back from reserve by then included">playoff wks</th>
                      {[you, them].map((s, i) => (
                        <td key={i} class={s.playoffLineup > 0.05 ? "up" : s.playoffLineup < -0.05 ? "down" : ""}>
                          {signed(s.playoffLineup, 1)}
                        </td>
                      ))}
                    </tr>
                  )}
                  <tr>
                    <th title="points over a replacement player, for the games left this season">value now</th>
                    {[you, them].map((s, i) => (
                      <td key={i} class={s.players > 0.5 ? "up" : s.players < -0.5 ? "down" : ""}>
                        {signed(s.players)}
                      </td>
                    ))}
                  </tr>
                  {carries && anyPlayers && (
                    <tr>
                      <th title={laterTip}>{laterSays}</th>
                      {[you, them].map((s, i) => (
                        <td key={i} class={s.later > 0.5 ? "up" : s.later < -0.5 ? "down" : ""}>
                          {boardLooksAhead ? signed(s.later) : "…"}
                        </td>
                      ))}
                    </tr>
                  )}
                  {anyPicks && (
                    <tr>
                      <th title="what the picks are worth, in points over a replacement across the season they are made in">picks</th>
                      {[you, them].map((s, i) => (
                        <td key={i} class={s.future > 0.5 ? "up" : s.future < -0.5 ? "down" : ""}>
                          {signed(s.future)}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
              {(you.drop > 0 || them.drop > 0) && (
                <p class="hint">
                  {you.drop > 0 && `You'd drop ${you.drop} to make room. `}
                  {them.drop > 0 && `${deal.partner} would drop ${them.drop}.`}
                </p>
              )}
            </>
          )}
      </div>

      {/* a phone shows one roster at a time, a wide screen both */}
      <span class="seg tsidetabs" role="tablist">
        {(["send", "get"] as const).map((which) => (
          <button
            key={which}
            role="tab"
            aria-selected={shown === which}
            class={shown === which ? "on" : ""}
            onClick={() => setShown(which)}
          >
            {which === "send" ? "you send" : `you get`}
            {which === "send"
              ? (deal.give.length + deal.givePicks.length ? ` · ${deal.give.length + deal.givePicks.length}` : "")
              : (deal.get.length + deal.getPicks.length ? ` · ${deal.get.length + deal.getPicks.length}` : "")}
          </button>
        ))}
      </span>

      <div class={"tsides showing-" + shown}>
        <TradeSide
          which="send"
          title="you send"
          owner={league.team}
          keys={mine.keys}
          picks={picks.filter((p) => p.owner === league.team)}
          chosen={deal.give}
          chosenPicks={deal.givePicks}
          valueOf={valueOf}
          laterOf={carries && boardLooksAhead ? laterOf : null}
          laterSays={carries === "dynasty" ? "later" : "next yr"}
          valueOfPick={valueOfPick}
          byKey={sim.byKey}
          onPlayer={(k) => toggle("give", k)}
          onPick={(id) => toggle("givePicks", id)}
        />
        <TradeSide
          which="get"
          title={`you get from ${deal.partner}`}
          owner={deal.partner}
          keys={partner.keys}
          picks={picks.filter((p) => p.owner === deal.partner)}
          chosen={deal.get}
          chosenPicks={deal.getPicks}
          valueOf={valueOf}
          laterOf={carries && boardLooksAhead ? laterOf : null}
          laterSays={carries === "dynasty" ? "later" : "next yr"}
          valueOfPick={valueOfPick}
          byKey={sim.byKey}
          onPlayer={(k) => toggle("get", k)}
          onPick={(id) => toggle("getPicks", id)}
        />
      </div>

      <p class="hint tnote">
        value: points over a replacement, rest of this season
        {hasPicks ? " · a pick: its draft's season, at the spot its team is on course for" : ""}
        {carries === "dynasty" && boardLooksAhead &&
          ` · later: his next ${SEASONS_AHEAD} seasons, each worth ${SEASON_OUT} of the one before`}
        {carries === "keeper" && boardLooksAhead &&
          ` · next yr: next season over the pick he costs to keep${
            Object.keys(costs).length ? "" : ", none priced yet so each is kept free"}; a team keeps its best ${perTeam}`}
        {carries && !boardLooksAhead && " · players' later seasons aren't on the board yet"}
      </p>
      <p class="hint tnote" title={HOW_ODDS_WORK_IN_FULL}>
        Odds: {SEASONS.toLocaleString()} simulated seasons, before and after the trade. {HOW_ODDS_WORK}
      </p>
    </div>
  );
}

/** a chance before and after, and the change as the two rounded figures say it */
function OddsRow(
  props: { label: string; says: string; sides: { before: number | null; after: number | null }[] },
) {
  return (
    <tr>
      <th title={props.says}>{props.label}</th>
      {props.sides.map((s, i) => {
        if (s.before === null || s.after === null) {
          return <td key={i}>…</td>;
        }

        const moved = Math.round(s.after * 100) - Math.round(s.before * 100);

        return (
          <td key={i}>
            {pctOf(s.before)} → <b>{pctOf(s.after)}</b>
            <em class={moved > 0 ? "up" : moved < 0 ? "down" : ""}>{signed(moved)}</em>
          </td>
        );
      })}
    </tr>
  );
}

function TradeSide(
  props: {
    which: "send" | "get";
    title: string;
    owner: string;
    keys: { key: string; name: string; pos?: string | undefined; team?: string | undefined }[];
    picks: DraftPick[];
    chosen: string[];
    chosenPicks: string[];
    valueOf: (key: string) => number;
    /** what he is worth past this season, where anything is */
    laterOf: ((key: string) => number | null) | null;
    laterSays: string;
    valueOfPick: (p: DraftPick) => number;
    byKey: Map<string, Player>;
    onPlayer: (key: string) => void;
    onPick: (id: string) => void;
  },
) {
  const all = props.keys
    .map((p) => ({ p, value: props.valueOf(p.key), later: props.laterOf?.(p.key) ?? null }))
    .sort((a, b) => b.value + (b.later ?? 0) - a.value - (a.later ?? 0));
  // the players worth nothing over a replacement now or later fold away,
  // bar any already ticked, since a trade is rarely about them; a rookie
  // on reserve is worth nothing now and the most of anyone later
  const [open, setOpen] = useState(false);
  const worth = (r: (typeof all)[number]) =>
    Math.round(r.value) > 0 || Math.round(r.later ?? 0) > 0 || props.chosen.includes(r.p.key);
  const rows = open ? all : all.filter(worth);
  const folded = all.length - all.filter(worth).length;
  // the picks by season and round; a team's own come before ones it bought
  const picks = [...props.picks].sort((a, b) =>
    a.season - b.season || a.round - b.round || Number(a.from !== props.owner) - Number(b.from !== props.owner));
  const seasons = [...new Set(picks.map((p) => p.season))];

  return (
    <section class={"tside " + props.which}>
      <h3>
        <span>{props.title}</span>
        <span class="tvals">
          <i title="points over a replacement player for the games left this season; a pick, over the season it is made in">value</i>
          {props.laterOf && <i title="what he is worth past this season, in points over a replacement">{props.laterSays}</i>}
        </span>
      </h3>
      <ul class="tlistrows">
        {rows.map(({ p, value, later }) => {
          const on = props.chosen.includes(p.key);
          const his = props.byKey.get(p.key);

          return (
            <li key={p.key}>
              <button class={"trow2" + (on ? " on" : "")} aria-pressed={on} onClick={() => props.onPlayer(p.key)}>
                <span class="tbox" aria-hidden="true" />
                <span class="tname2">
                  {p.name}
                  <i>{his?.position ?? p.pos}{p.team ? ` · ${p.team}` : ""}</i>
                </span>
                <span class="tval">{valueSays(value)}</span>
                {props.laterOf && <span class="tval later">{later === null ? "–" : valueSays(later)}</span>}
              </button>
            </li>
          );
        })}
        {folded > 0 && (
          <li>
            <button class="tmore" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "fewer" : `${folded} more worth nothing over a replacement${props.laterOf ? "" : " now"}`}
            </button>
          </li>
        )}
      </ul>
      {seasons.length > 0 && (
        <div class="tpicks">
          {seasons.map((season) => (
            <div class="tpickrow" key={season}>
              <span class="tseason">{season}</span>
              <div class="tchips">
                {picks.filter((p) => p.season === season).map((pick) => {
                  const id = pickId(pick);
                  const on = props.chosenPicks.includes(id);

                  return (
                    <button
                      key={id}
                      class={"tchip" + (on ? " on" : "")}
                      aria-pressed={on}
                      title={pick.from === props.owner ? "own pick" : `from ${pick.from}`}
                      onClick={() => props.onPick(id)}
                    >
                      {ordinal(pick.round)}
                      {pick.from !== props.owner && <i>{pick.from}</i>}
                      <small>{valueSays(props.valueOfPick(pick))}</small>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

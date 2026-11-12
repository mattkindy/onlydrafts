/**
 * Weigh a trade: choose who you deal with, tick what each side sends,
 * players and draft picks, and see what it does to both teams.
 *
 * The verdict is the playoff race played out twice, as it stands and with
 * the two rosters swapped, on the same draws so the difference is the
 * trade and not the dice. Beside it, each side's best weekly lineup, what
 * the players are worth for the rest of the season, and the picks, which
 * are what a team giving up on this season is buying.
 *
 * Both sides are shown because a trade the other manager loses is a trade
 * nobody accepts, and finding one that helps you both is the job.
 */

import { useMemo, useState } from "preact/hooks";

import type { Listed } from "../lib/availability.ts";
import { readRules, rulesKey } from "../lib/playoffRules.ts";
import type { DraftPick, League } from "../lib/providers.ts";
import type { Player } from "../lib/scoring.ts";
import { playoffOdds, type PlayoffOdds, type Strength } from "../lib/seasonStats.ts";
import { teamStrengths, useSeasonSim } from "../lib/seasonSim.ts";
import { keep, stored } from "../lib/store.ts";
import {
  dealIsEmpty, draftCurve, NO_DEAL, overTheLimit, pickId, pickValue, restOfSeason,
  rostersAfter, slotsFromWins, valueSays, type Deal,
} from "../lib/trade.ts";
import { ordinal } from "./Standings.tsx";

/** how often each version of the season is played out, as the stats tab does */
const SEASONS = 5000;

/** the fantasy playoffs most leagues run after the regular season */
const PLAYOFF_WEEKS = 3;

interface Props {
  league: League;
  players: Player[];
  /** the week coming up */
  coming: number;
  listed: Map<string, Listed>;
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
  const weeksLeft = Math.max(0, Math.min(17, lastRegular + PLAYOFF_WEEKS) - coming + 1);
  const rules = useMemo(() => readRules(stored(rulesKey(league), null), league), [league]);
  const divisionOf = useMemo(() => new Map(league.allRosters
    .filter((r) => typeof r.division === "number")
    .map((r) => [r.owner, r.division!])), [league]);

  const playOut = (strength: Map<string, Strength>) => sim.setup
    ? playoffOdds({
        table: sim.setup.table,
        weeks: sim.setup.toCome,
        strength,
        playoffTeams: rules.teams,
        rules,
        divisionOf,
        mine: league.team,
        draws: SEASONS,
      }).odds
    : null;

  const before = useMemo(() => playOut(sim.strength), [sim.setup, sim.strength, rules, divisionOf]);
  const dealKey = JSON.stringify(deal);
  const afterStrength = useMemo(() => teamStrengths({
    rosters: rostersAfter(league, deal),
    slots: league.slots,
    byKey: sim.byKey,
    listed,
    season: sim.season,
    scaleFrom: league.allRosters,
  }), [dealKey, league, sim.byKey, sim.season, listed]);
  const after = useMemo(
    () => (dealIsEmpty(deal) ? before : playOut(afterStrength)),
    [dealKey, afterStrength, before],
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
    odds?.find((o) => o.owner === owner)?.playoffs ?? null;
  const lineupOf = (strength: Map<string, Strength>, owner: string) => strength.get(owner)?.mean ?? 0;
  const closed = league.tradeDeadline !== null && league.tradeDeadline !== undefined &&
    coming > league.tradeDeadline;

  const side = (owner: string, give: boolean) => {
    const now = { before: oddsOf(before, owner), after: oddsOf(after, owner) };
    const lineup = lineupOf(afterStrength, owner) - lineupOf(sim.strength, owner);
    const players = give ? getNow - giveNow : giveNow - getNow;
    const future = give ? getPicks - givePicks : givePicks - getPicks;
    const drop = overTheLimit(league, deal, give ? "mine" : "theirs");

    return { now, lineup, players, future, drop };
  };
  const you = side(league.team, true);
  const them = side(deal.partner, false);
  // the change as the two rounded figures beside it say it, so 22% → 27% reads +5
  const delta = (s: typeof you) =>
    s.now.before !== null && s.now.after !== null
      ? (Math.round(s.now.after * 100) - Math.round(s.now.before * 100)) / 100
      : null;
  const verdict = (() => {
    const a = delta(you);
    const b = delta(them);

    if (a === null || b === null || dealIsEmpty(deal)) {
      return null;
    }

    // the picks pull the other way from the season, which is a choice
    // between now and later rather than a winner
    const later = you.future;

    if (a > 0.01 && later < -0.5) {
      return { says: "wins now, costs later", tone: "flat" };
    }

    if (a < -0.01 && later > 0.5) {
      return { says: "costs now, pays later", tone: "flat" };
    }

    // a point either way is the dice, not the trade
    if (a > 0.01 && b > -0.01) {
      return { says: "helps you both", tone: "up" };
    }

    if (a > 0.01) {
      return { says: "better for you", tone: "up" };
    }

    if (a < -0.01 && b > 0.01) {
      return { says: "better for them", tone: "down" };
    }

    if (a < -0.01) {
      return { says: "costs you", tone: "down" };
    }

    return { says: later > 0.5 ? "even now, pays later" : later < -0.5 ? "even now, costs later" : "about even", tone: "flat" };
  })();
  const hasPicks = picks.length > 0;
  const anyPicks = deal.givePicks.length + deal.getPicks.length > 0;

  return (
    <div class="trade rhythm">
      <div class="tpartner">
        <span class="tlabel">trade with</span>
        <div class="chips" role="tablist">
          {others.map((r) => (
            <button
              key={r.owner}
              role="tab"
              aria-selected={r.owner === deal.partner}
              class={r.owner === deal.partner ? "on" : ""}
              onClick={() => choosePartner(r.owner)}
            >
              {r.owner}
            </button>
          ))}
        </div>
      </div>

      {league.tradeDeadline && (
        <p class={"hint" + (closed ? " warn" : "")}>
          {closed
            ? `The trade deadline was week ${league.tradeDeadline}, so this is a what-if.`
            : `Trades close after week ${league.tradeDeadline}.`}
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
              <table class="tgrid">
                <thead>
                  <tr><th /><th>you</th><th>{deal.partner}</th></tr>
                </thead>
                <tbody>
                  {sim.setup && (
                    <tr>
                      <th title="how often the team makes the playoffs, with the rest of the season played out 5,000 times">playoffs</th>
                      {[you, them].map((s, i) => (
                        <td key={i}>
                          {s.now.before === null
                            ? "…"
                            : <>
                                {pctOf(s.now.before)} → <b>{pctOf(s.now.after!)}</b>
                                <em class={delta(s)! > 0.005 ? "up" : delta(s)! < -0.005 ? "down" : ""}>
                                  {signed(Math.round(delta(s)! * 100))}
                                </em>
                              </>}
                        </td>
                      ))}
                    </tr>
                  )}
                  <tr>
                    <th title="points a week from the best lineup the roster can start">lineup / wk</th>
                    {[you, them].map((s, i) => (
                      <td key={i} class={s.lineup > 0.05 ? "up" : s.lineup < -0.05 ? "down" : ""}>
                        {signed(s.lineup, 1)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th title="points over a replacement player, for the games left this season">value now</th>
                    {[you, them].map((s, i) => (
                      <td key={i} class={s.players > 0.5 ? "up" : s.players < -0.5 ? "down" : ""}>
                        {signed(s.players)}
                      </td>
                    ))}
                  </tr>
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
          valueOfPick={valueOfPick}
          byKey={sim.byKey}
          onPlayer={(k) => toggle("get", k)}
          onPick={(id) => toggle("getPicks", id)}
        />
      </div>

      <p class="hint tnote">
        value: points over a replacement, rest of this season
        {hasPicks ? " · a pick: its draft's season, at the spot its team is on course for" : ""}
        {league.dynasty ? " · players' later seasons not counted yet" : ""}
      </p>
    </div>
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
    valueOfPick: (p: DraftPick) => number;
    byKey: Map<string, Player>;
    onPlayer: (key: string) => void;
    onPick: (id: string) => void;
  },
) {
  const all = props.keys
    .map((p) => ({ p, value: props.valueOf(p.key) }))
    .sort((a, b) => b.value - a.value);
  // the players worth nothing over a replacement now fold away, bar any
  // already ticked, since a trade is rarely about them
  const [open, setOpen] = useState(false);
  const worth = (r: (typeof all)[number]) => Math.round(r.value) > 0 || props.chosen.includes(r.p.key);
  const rows = open ? all : all.filter(worth);
  const folded = all.length - all.filter(worth).length;
  // the picks by season and round; a team's own come before ones it bought
  const picks = [...props.picks].sort((a, b) =>
    a.season - b.season || a.round - b.round || Number(a.from !== props.owner) - Number(b.from !== props.owner));
  const seasons = [...new Set(picks.map((p) => p.season))];

  return (
    <section class={"tside " + props.which}>
      <h3><span>{props.title}</span><i title="points over a replacement player for the games left this season; a pick, over the season it is made in">value</i></h3>
      <ul class="tlistrows">
        {rows.map(({ p, value }) => {
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
              </button>
            </li>
          );
        })}
        {folded > 0 && (
          <li>
            <button class="tmore" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "fewer" : `${folded} more worth nothing over a replacement now`}
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

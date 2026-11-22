/**
 * How the league decides its playoffs, set by hand where the provider
 * did not say or said it differently: how many get in, what ranks the
 * table, whether division winners get in first, and the tiebreakers in
 * the order they are tried. Tapping a tiebreaker adds it to the end of
 * the order, and tapping it again takes it out. Where division winners
 * get in, the wild cards can have tiebreakers of their own.
 */

import {
  leagueRules, SEED_SAYS, TIE_SAYS,
  type PlayoffRules, type SeedBy, type Tiebreak,
} from "../lib/playoffRules.ts";

interface LeagueSays {
  provider: string;
  leagueId: string;
  size: number;
  playoffTeams?: number | null;
  divisions?: { id: number; name: string }[] | null;
  medianGame?: boolean | null;
  seedTiebreak?: Tiebreak | null;
}

export function RulesPanel({ league, rules, onRules, onDone }: {
  league: LeagueSays;
  rules: PlayoffRules;
  onRules: (rules: PlayoffRules) => void;
  /** where the panel sits open on its own page, there is nothing to close */
  onDone?: () => void;
}) {
  const divisions = league.divisions?.length ?? 0;
  const own = leagueRules(league);
  const isOwn = JSON.stringify(own) === JSON.stringify(rules);
  // a tiebreaker that says the same as the ranking is no use
  const pointless = (tie: Tiebreak, seedBy: SeedBy) =>
    (tie === "wins" && (seedBy === "wins" || seedBy === "median")) ||
    (tie === "pf" && seedBy === "pf") ||
    (tie === "allplay" && seedBy === "allplay");
  // the chosen ones lead, in their order, and the pointless are left off
  const offered = (chosen: Tiebreak[]) => [
    ...chosen,
    ...(Object.keys(TIE_SAYS) as Tiebreak[]).filter((tie) => !chosen.includes(tie)),
  ].filter((tie) => !(tie === "division" && divisions < 2) && !pointless(tie, rules.seedBy));
  const set = (change: Partial<PlayoffRules>) => {
    const next = { ...rules, ...change };

    // a tiebreaker the new ranking makes pointless goes
    next.ties = next.ties.filter((tie) => !pointless(tie, next.seedBy));

    // and wild cards left with none go back to the same as everybody
    next.wildTies = next.wildTies?.filter((tie) => !pointless(tie, next.seedBy));

    if (!next.wildTies?.length) {
      delete next.wildTies;
    }

    onRules(next);
  };
  const toggled = (list: Tiebreak[], tie: Tiebreak) =>
    list.includes(tie) ? list.filter((t) => t !== tie) : [...list, tie];
  const wild = rules.teams - divisions;
  // the wild cards' own tiebreakers, where division winners get in
  const ownWild = rules.divisions && divisions > 1;
  const chips = (chosen: Tiebreak[], toggle: (tie: Tiebreak) => void) =>
    offered(chosen).map((tie) => {
      const at = chosen.indexOf(tie);

      return (
        <button
          key={tie} class={at >= 0 ? "on" : ""} aria-pressed={at >= 0}
          onClick={() => toggle(tie)}
        >
          {at >= 0 && <span class="nth">{at + 1}</span>}
          {TIE_SAYS[tie]}
        </button>
      );
    });

  return (
    <section class="rules" aria-label="playoff rules">
      <div class="rrow">
        <i>make it</i>
        <div class="stepper">
          <button
            aria-label="one fewer team" disabled={rules.teams <= 1}
            onClick={() => set({ teams: rules.teams - 1 })}
          >−</button>
          <b>{rules.teams}</b>
          <button
            aria-label="one more team" disabled={rules.teams >= league.size}
            onClick={() => set({ teams: rules.teams + 1 })}
          >+</button>
        </div>
      </div>
      <div class="rrow">
        <i>seeded by</i>
        <div class="chips flow">
          {(Object.keys(SEED_SAYS) as SeedBy[]).map((seed) => (
            <button
              key={seed} class={rules.seedBy === seed ? "on" : ""}
              aria-pressed={rules.seedBy === seed} onClick={() => set({ seedBy: seed })}
            >
              {SEED_SAYS[seed]}
            </button>
          ))}
        </div>
      </div>
      {divisions > 1 && (
        <div class="rrow">
          <i>divisions</i>
          <div class="chips flow">
            <button
              class={rules.divisions ? "on" : ""} aria-pressed={rules.divisions}
              onClick={() => set({ divisions: !rules.divisions })}
            >
              {divisions} winners in{rules.divisions && wild >= 0
                ? ` · ${wild} wild card${wild === 1 ? "" : "s"}` : ""}
            </button>
          </div>
        </div>
      )}
      <div class="rrow">
        <i>{ownWild && rules.wildTies ? "tiebreakers in a division" : "tiebreakers"}</i>
        <div class="chips flow">
          {chips(rules.ties, (tie) => set({ ties: toggled(rules.ties, tie) }))}
        </div>
      </div>
      {ownWild && (
        <div class="rrow">
          <i>wild card tiebreakers</i>
          <div class="chips flow">
            <button
              class={rules.wildTies ? "" : "on"} aria-pressed={!rules.wildTies}
              onClick={() => set({ wildTies: undefined })}
            >
              same as above
            </button>
            {chips(rules.wildTies ?? [], (tie) =>
              set({ wildTies: toggled(rules.wildTies ?? [], tie) }))}
          </div>
          {rules.wildTies && (
            <p class="rsrc">
              Of the tied teams only each division's best is compared, and once one
              is placed the rest start over, as the NFL does. An h2h sweep splits three
              or more teams only where one beat, or lost to, all the others.
            </p>
          )}
        </div>
      )}
      <div class="rfoot">
        {!isOwn && (
          <button class="textbtn" onClick={() => onRules(own)}>league's settings</button>
        )}
        {onDone && <button class="textbtn" onClick={onDone}>done</button>}
      </div>
    </section>
  );
}

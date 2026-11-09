/**
 * How the league decides its playoffs, set by hand where the provider
 * did not say or said it differently: how many get in, what ranks the
 * table, whether division winners get in first, and the tiebreakers in
 * the order they are tried. Tapping a tiebreaker adds it to the end of
 * the order, and tapping it again takes it out.
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
  onDone: () => void;
}) {
  const divisions = league.divisions?.length ?? 0;
  const own = leagueRules(league);
  const isOwn = JSON.stringify(own) === JSON.stringify(rules);
  // the chosen ones lead, in their order, and a tiebreaker that says the
  // same as the ranking is left off the list
  const offered = [
    ...rules.ties,
    ...(Object.keys(TIE_SAYS) as Tiebreak[]).filter((tie) => !rules.ties.includes(tie)),
  ].filter((tie) =>
    !(tie === "division" && divisions < 2) &&
    !(tie === "wins" && (rules.seedBy === "wins" || rules.seedBy === "median")) &&
    !(tie === "pf" && rules.seedBy === "pf") &&
    !(tie === "allplay" && rules.seedBy === "allplay"));
  const set = (change: Partial<PlayoffRules>) => {
    const next = { ...rules, ...change };

    // a tiebreaker the new ranking makes pointless goes
    next.ties = next.ties.filter((tie) =>
      !(tie === "wins" && (next.seedBy === "wins" || next.seedBy === "median")) &&
      !(tie === "pf" && next.seedBy === "pf") &&
      !(tie === "allplay" && next.seedBy === "allplay"));
    onRules(next);
  };
  const toggleTie = (tie: Tiebreak) => set({
    ties: rules.ties.includes(tie) ? rules.ties.filter((t) => t !== tie) : [...rules.ties, tie],
  });
  const wild = rules.teams - divisions;

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
        <i>tiebreakers</i>
        <div class="chips flow">
          {offered.map((tie) => {
            const at = rules.ties.indexOf(tie);

            return (
              <button
                key={tie} class={at >= 0 ? "on" : ""} aria-pressed={at >= 0}
                onClick={() => toggleTie(tie)}
              >
                {at >= 0 && <span class="nth">{at + 1}</span>}
                {TIE_SAYS[tie]}
              </button>
            );
          })}
        </div>
      </div>
      <div class="rfoot">
        {!isOwn && (
          <button class="textbtn" onClick={() => onRules(own)}>league's settings</button>
        )}
        <button class="textbtn" onClick={onDone}>done</button>
      </div>
    </section>
  );
}

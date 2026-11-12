/**
 * The league's settings as the app reads them, each one settable by hand
 * where the provider did not say or said it wrong: what kind of league it
 * is, when the regular season ends, when trades close, and how the
 * playoffs are decided. Beside anything you set is what the provider
 * says, and a tap puts it back.
 */

import { useState } from "preact/hooks";

import {
  KIND_SAYS, settingsSaid, type LeagueKind, type LeagueSettings, type Said,
} from "../lib/leagueSettings.ts";
import { readRules, rulesKey, type PlayoffRules } from "../lib/playoffRules.ts";
import type { League } from "../lib/providers.ts";
import { keep, stored } from "../lib/store.ts";
import { RulesPanel } from "./RulesPanel.tsx";

const PROVIDER_SAYS: Record<string, string> = { sleeper: "Sleeper", espn: "ESPN" };

/** the latest a regular season runs, a week short of the NFL's own */
const LAST_WEEK = 17;

export function LeagueSettingsPanel({ league, settings, onSettings }: {
  /** the league as the provider sent it, before any of your settings */
  league: League;
  settings: LeagueSettings;
  onSettings: (next: LeagueSettings) => void;
}) {
  const said = settingsSaid(league, settings);
  const who = PROVIDER_SAYS[league.provider] ?? league.provider;
  const set = (change: Partial<LeagueSettings>) => onSettings({ ...settings, ...change });
  const unset = (key: keyof LeagueSettings) => {
    const next = { ...settings };

    delete next[key];
    onSettings(next);
  };
  const [rules, setRulesNow] = useState<PlayoffRules>(() =>
    readRules(stored(rulesKey(league), null), league));
  const setRules = (next: PlayoffRules) => {
    setRulesNow(next);
    keep(rulesKey(league), next);
  };
  const last = said.lastRegularWeek.value;
  const deadline = said.tradeDeadline.value;

  return (
    <div class="lsettings rhythm">
      <section class="rules" aria-label="league settings">
        <div class="rrow">
          <i>league</i>
          <div class="chips flow">
            {(Object.keys(KIND_SAYS) as LeagueKind[]).map((kind) => (
              <button
                key={kind} class={said.kind.value === kind ? "on" : ""}
                aria-pressed={said.kind.value === kind} onClick={() => set({ kind })}
              >
                {KIND_SAYS[kind]}
              </button>
            ))}
          </div>
          <Source said={said.kind} who={who} says={(k) => KIND_SAYS[k]} onReset={() => unset("kind")} />
        </div>

        <div class="rrow">
          <i>regular season ends</i>
          <div class="stepper">
            <button
              aria-label="a week earlier" disabled={last <= 8}
              onClick={() => set({ lastRegularWeek: last - 1 })}
            >−</button>
            <b>wk {last}</b>
            <button
              aria-label="a week later" disabled={last >= LAST_WEEK - 1}
              onClick={() => set({ lastRegularWeek: last + 1 })}
            >+</button>
          </div>
          <Source
            said={said.lastRegularWeek} who={who} says={(w) => `week ${w}`}
            onReset={() => unset("lastRegularWeek")}
          />
        </div>

        <div class="rrow">
          <i>trade deadline</i>
          <div class="rline">
            <div class="stepper">
              <button
                aria-label="a week earlier" disabled={deadline !== null && deadline <= 1}
                onClick={() => set({ tradeDeadline: Math.max(1, (deadline ?? last) - 1) })}
              >−</button>
              <b>{deadline === null ? "none" : `wk ${deadline}`}</b>
              <button
                aria-label="a week later" disabled={deadline !== null && deadline >= last}
                onClick={() => set({ tradeDeadline: deadline === null ? Math.max(1, last - 3) : deadline + 1 })}
              >+</button>
            </div>
            {deadline !== null && (
              <button class="textbtn" onClick={() => set({ tradeDeadline: null })}>no deadline</button>
            )}
          </div>
          <Source
            said={said.tradeDeadline} who={who}
            says={(w) => (w === null ? "no deadline" : `week ${w}`)}
            onReset={() => unset("tradeDeadline")}
          />
        </div>
      </section>

      <h3 class="lsub">playoffs</h3>
      <RulesPanel league={league} rules={rules} onRules={setRules} />
    </div>
  );
}

/**
 * Where a setting comes from: nothing to say when it is the provider's,
 * a way back to the provider's where you changed it, and a word where the
 * provider says nothing, so a guess is not mistaken for the league's.
 */
function Source<T>({ said, who, says, onReset }: {
  said: Said<T>;
  who: string;
  says: (value: T) => string;
  onReset: () => void;
}) {
  if (said.yours && said.known) {
    return (
      <p class="rsrc">
        yours · {who} says {says(said.provider as T)}{" "}
        <button class="textbtn" onClick={onReset}>use it</button>
      </p>
    );
  }

  if (said.yours) {
    return (
      <p class="rsrc">
        yours · {who} doesn't say{" "}
        <button class="textbtn" onClick={onReset}>clear</button>
      </p>
    );
  }

  return said.known ? null : <p class="rsrc">{who} doesn't say; set it if this is wrong</p>;
}

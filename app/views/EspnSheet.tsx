/**
 * What to do about a private ESPN league, in the order you do it.
 *
 * Only espn.com can read the two cookies that open one, and only a
 * request from outside a browser can use them, so both halves need
 * you: fetch them from their site, leave them here, and the relay takes
 * them the rest of the way.
 */

import { useState } from "preact/hooks";
import { keep } from "../lib/store.ts";
import { espnCookiesFrom } from "../lib/providers.ts";
import { useSheet } from "./useSheet.ts";

const STEPS = [
  <>Sign in at <a href="https://www.espn.com/fantasy/" target="_blank" rel="noreferrer">espn.com</a> in this browser.</>,
  <>Open the developer tools: F12 on Windows, or option and command and I on a Mac.</>,
  <>Go to Application, then Cookies, then espn.com.</>,
  <>Copy the value of <b>SWID</b>, which looks like {"{A1B2-C3D4}"}, and of <b>espn_s2</b>, which is a long line of letters.</>,
  <>Paste both below. They stay in this browser and go nowhere except to ESPN.</>,
];

/** what a paste that would not save is missing, in the words of the steps */
export function missingWords(
  found: { swid: string; s2: string }, pasted: string,
): string {
  if (!pasted.trim()) {
    return "Nothing was pasted. Paste both values, then save.";
  }

  if (!found.swid && !found.s2) {
    return "Couldn't find either value. SWID looks like " +
      "{A1B2C3D4-E5F6-...} and espn_s2 is a long line of 100 or more " +
      "letters and numbers.";
  }

  return found.swid
    ? "Found SWID but not espn_s2. Copy its whole value, a long line of " +
      "100 or more letters and numbers, and paste it beside the SWID."
    : "Found espn_s2 but not SWID. Copy its value, which looks like " +
      "{A1B2C3D4-E5F6-...}, and paste it beside the espn_s2.";
}

export function EspnSheet(
  { onClose, onKept }: { onClose: () => void; onKept: () => void },
) {
  const [pasted, setPasted] = useState("");
  const [missed, setMissed] = useState("");

  /**
   * A paste that is missing one of the two says which, and stays in the
   * box. It used to empty the box and change only the faint placeholder,
   * which looked exactly like having saved.
   */
  const take = () => {
    const found = espnCookiesFrom(pasted);

    if (!found.swid || !found.s2) {
      setMissed(missingWords(found, pasted));

      return;
    }

    keep("espnSwid", found.swid);
    keep("espnS2", found.s2);
    onKept();
  };

  const sheet = useSheet(onClose);

  return (
    <div id="overlay" class="open" onClick={onClose}>
      <div
        class="sheet" ref={sheet} role="dialog" aria-modal="true"
        aria-label="opening a private ESPN league"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Opening a private ESPN league</h3>
        <div class="sub">
          ESPN only shares the two cookies that sign you in with its own
          pages, so you have to copy them over yourself. You need to do
          this about once a season, when they expire.
        </div>
        {STEPS.map((what, i) => (
          <div class="step" key={i}><span>{i + 1}</span><span>{what}</span></div>
        ))}
        <label class="pastewrap">
          SWID and espn_s2
          <textarea
            rows={3}
            value={pasted}
            placeholder="SWID={...}; espn_s2=..."
            onInput={(e) => {
              setPasted(e.currentTarget.value);
              setMissed("");
            }}
          />
        </label>
        {missed && <p class="hint missed" role="alert">{missed}</p>}
        <div class="row">
          <button class="act" onClick={take}>save</button>
          <button
            class="act"
            style={{ background: "var(--chip)", color: "var(--ink)" }}
            onClick={onClose}
          >
            close
          </button>
        </div>
      </div>
    </div>
  );
}

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

const STEPS = [
  <>Sign in at <a href="https://www.espn.com/fantasy/" target="_blank" rel="noreferrer">espn.com</a> in this browser.</>,
  <>Open the developer tools: F12 on Windows, or option and command and I on a Mac.</>,
  <>Go to Application, then Cookies, then espn.com.</>,
  <>Copy the value of <b>SWID</b>, which looks like {"{A1B2-C3D4}"}, and of <b>espn_s2</b>, which is a long line of letters.</>,
  <>Paste both below. They stay in this browser and go nowhere except to ESPN.</>,
];

export function EspnSheet(
  { onClose, onKept }: { onClose: () => void; onKept: () => void },
) {
  const [pasted, setPasted] = useState("");
  const [missed, setMissed] = useState(false);

  const take = () => {
    const found = espnCookiesFrom(pasted);

    if (!found.swid || !found.s2) {
      setPasted("");
      setMissed(true);

      return;
    }

    keep("espnSwid", found.swid);
    keep("espnS2", found.s2);
    onKept();
  };

  return (
    <div id="overlay" class="open" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Opening a private ESPN league</h3>
        <div class="sub">
          ESPN only lets its own pages read the two cookies that identify
          you, so they have to be fetched by hand. This is once a season,
          until they expire.
        </div>
        {STEPS.map((what, i) => (
          <div class="step" key={i}><span>{i + 1}</span><span>{what}</span></div>
        ))}
        <label class="pastewrap">
          SWID and espn_s2
          <textarea
            rows={3}
            value={pasted}
            placeholder={missed
              ? "that did not have both in it"
              : "SWID={...}; espn_s2=..."}
            onInput={(e) => setPasted(e.currentTarget.value)}
          />
        </label>
        <div class="row">
          <button class="act" onClick={take}>keep them</button>
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

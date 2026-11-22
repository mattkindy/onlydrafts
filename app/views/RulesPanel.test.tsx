/**
 * The playoff rules a reader sets by hand, here the wild cards'
 * tiebreakers of their own where division winners get in.
 */

import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { leagueRules, type PlayoffRules } from "../lib/playoffRules.ts";
import { RulesPanel } from "./RulesPanel.tsx";

const LEAGUE = {
  provider: "sleeper", leagueId: "1", size: 12, playoffTeams: 6,
  divisions: [{ id: 1, name: "East" }, { id: 2, name: "West" }, { id: 3, name: "North" }],
};

const host = document.createElement("div");

afterEach(() => render(null, host));

/** the panel, and every set of rules it hands back */
function panelWith(rules: PlayoffRules, league = LEAGUE) {
  const said: PlayoffRules[] = [];

  act(() => render(<RulesPanel league={league} rules={rules} onRules={(r) => said.push(r)} />, host));

  return said;
}

const row = (label: string) => Array.from(host.querySelectorAll(".rrow"))
  .find((r) => r.querySelector("i")?.textContent === label);

const tap = (label: string, text: string) => act(() => {
  Array.from(row(label)!.querySelectorAll("button"))
    .find((b) => b.textContent?.endsWith(text))!.click();
});

describe("the wild cards' own tiebreakers", () => {
  it("start the same as everybody's, and take their own list when one is tapped", () => {
    const said = panelWith(leagueRules(LEAGUE));

    expect(row("wild card tiebreakers")!.querySelector("button.on")!.textContent)
      .toBe("same as above");
    tap("wild card tiebreakers", "h2h sweep");
    expect(said.at(-1)!.wildTies).toEqual(["sweep"]);
  });

  it("rank each division by the list above once they have their own", () => {
    const said = panelWith({
      ...leagueRules(LEAGUE), ties: ["h2h", "division"], wildTies: ["sweep", "pf"],
    });

    expect(row("tiebreakers in a division")).toBeDefined();
    expect(Array.from(row("wild card tiebreakers")!.querySelectorAll("button.on")).map((b) => b.textContent))
      .toEqual(["1h2h sweep", "2points for"]);
    tap("wild card tiebreakers", "same as above");
    expect(said.at(-1)).not.toHaveProperty("wildTies");
  });

  it("are not offered without division winners getting in", () => {
    panelWith({ ...leagueRules(LEAGUE), divisions: false });

    expect(row("wild card tiebreakers")).toBeUndefined();
    expect(row("tiebreakers")).toBeDefined();
  });
});

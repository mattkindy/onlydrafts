import { describe, expect, it } from "vitest";
import { render } from "preact";
import { act } from "preact/test-utils";

import type { League } from "../lib/providers.ts";
import { NO_SCENARIO, scenarioLeague, type Move, type Scenario } from "../lib/scenario.ts";
import { moveDetail, moveTitle, WhatIfBar } from "./WhatIf.tsx";

const p = (key: string) => ({ key, name: key.toUpperCase(), pos: "RB" });

const pending: Move = {
  id: "league:9", by: "league", status: "pending", picks: [],
  players: [{ ...p("c"), from: "bo", to: "cy" }, { ...p("e"), from: "cy", to: "bo" }],
};

const mine: Move = {
  id: "you:1", by: "you",
  players: [{ ...p("a"), from: "me", to: "bo" }, { ...p("d"), from: "bo", to: "me" }],
  picks: [{ id: "2027:1:bo", season: 2027, round: 1, original: "bo", giver: "bo", to: "me" }],
};

const league: League = {
  provider: "sleeper", leagueId: "1", season: 2026, name: "l", size: 3, pays: {}, slots: null,
  userId: "u", team: "me", members: {}, myRoster: [p("a"), p("b")], myPicks: [], draftSlot: null,
  snake: true,
  allRosters: [
    { owner: "me", picks: [], keys: [p("a"), p("b")] },
    { owner: "bo", picks: [], keys: [p("c"), p("d")] },
    { owner: "cy", picks: [], keys: [p("e")] },
  ],
  picks: [{ season: 2027, round: 1, from: "bo", owner: "bo" }],
  pending: [pending],
};

function mount(start: Scenario, onEdit?: (m: Move) => void) {
  const where = document.createElement("div");
  let now = start;
  const draw = () => render(
    <WhatIfBar
      league={league}
      whatIf={{ scenario: now, world: scenarioLeague(league, now), onScenario: (next) => { now = next; draw(); } }}
      onEdit={onEdit}
    />,
    where,
  );

  act(draw);

  return { where, scenario: () => now };
}

describe("a trade in the what-if, as it reads", () => {
  it("names the teams, you first, and what each comes away with", () => {
    expect(moveTitle(mine, "me")).toBe("you ⇄ bo");
    expect(moveDetail(mine, "me")).toBe("you get D, 2027 1st · bo gets A");
    expect(moveDetail(pending, "me")).toBe("bo gets E · cy gets C");
  });
});

describe("the what-if panel", () => {
  it("lists the league's trade under review, counted, and says nothing of yours yet", () => {
    const { where } = mount(NO_SCENARIO);

    expect(where.querySelector(".wihead")!.textContent).toContain("counting 1 trade");
    expect(where.querySelector(".wiby")!.textContent).toBe("in review");
    expect(where.querySelector(".wiswitch")!.getAttribute("aria-checked")).toBe("true");
    // the league's own can be switched off but not removed
    expect(where.textContent).not.toContain("remove");
  });

  it("switches a trade off with a tap and keeps it listed", () => {
    const { where, scenario } = mount(NO_SCENARIO);

    act(() => (where.querySelector(".wiswitch") as HTMLButtonElement).click());

    expect(scenario().off).toEqual(["league:9"]);
    expect(where.querySelector(".wihead")!.textContent).toContain("as things stand");
    expect(where.querySelectorAll(".wimoves li").length).toBe(1);
  });

  it("offers your own trade to change or remove", () => {
    const edited: Move[] = [];
    const { where, scenario } = mount({ ...NO_SCENARIO, moves: [mine] }, (m) => edited.push(m));
    const buttons = Array.from(where.querySelectorAll<HTMLButtonElement>(".wiacts button"));

    act(() => buttons.find((b) => b.textContent === "edit")!.click());
    expect(edited).toEqual([mine]);

    act(() => buttons.find((b) => b.textContent === "remove")!.click());
    expect(scenario().moves).toEqual([]);
  });

  it("goes back to as things stand with every trade still listed", () => {
    const { where, scenario } = mount({
      ...NO_SCENARIO, moves: [mine], results: new Map([["12:bo|me", "me"]]), nudge: 0.1,
    });

    expect(where.querySelector(".wisettled")!.textContent).toContain("1 picked result · your scoring +10%");

    const back = Array.from(where.querySelectorAll(".wihead button"))
      .find((b) => b.textContent === "as it stands") as HTMLButtonElement;

    act(() => back.click());

    expect(scenario().off.sort()).toEqual(["league:9", "you:1"]);
    expect(scenario().results.size).toBe(0);
    expect(scenario().nudge).toBe(0);
    expect(where.querySelectorAll(".wimoves li").length).toBe(2);
  });

  it("says a trade whose player has moved on is left out, and why", () => {
    const late: Move = { ...mine, id: "you:2", players: [{ ...p("c"), from: "bo", to: "me" }], picks: [] };
    const { where } = mount({ ...NO_SCENARIO, moves: [late] });

    expect(where.querySelector(".wistale")!.textContent).toBe("left out: C is not on bo's roster");
  });

  it("draws nothing when there is nothing in it", () => {
    const where = document.createElement("div");
    const empty = { ...league, pending: [] };

    render(
      <WhatIfBar
        league={empty}
        whatIf={{ scenario: NO_SCENARIO, world: scenarioLeague(empty, NO_SCENARIO), onScenario: () => {} }}
      />,
      where,
    );

    expect(where.innerHTML).toBe("");
  });
});

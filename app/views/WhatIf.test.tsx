import { describe, expect, it } from "vitest";
import { render } from "preact";
import { act } from "preact/test-utils";

import type { League } from "../lib/providers.ts";
import { NO_SCENARIO, scenarioLeague, type Move, type Scenario } from "../lib/scenario.ts";
import {
  asItStands, moveLines, moveTitle, whatIfSays, WhatIfLine, WhatIfTrades, type WhatIfState,
} from "./WhatIf.tsx";

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

const stateOf = (scenario: Scenario, onScenario: (next: Scenario) => void = () => {}): WhatIfState =>
  ({ scenario, world: scenarioLeague(league, scenario), onScenario });

function mount(start: Scenario, onEdit?: (m: Move) => void) {
  const where = document.createElement("div");
  let now = start;
  const draw = () => render(
    <WhatIfTrades
      league={league}
      whatIf={stateOf(now, (next) => { now = next; draw(); })}
      onEdit={onEdit}
    />,
    where,
  );

  act(draw);

  return { where, scenario: () => now };
}

const button = (where: Element, says: string) =>
  Array.from(where.querySelectorAll("button")).find((b) => b.textContent === says) as HTMLButtonElement;

describe("a trade in the what-if, as it reads", () => {
  it("names the teams, you first, and says what you get and give a line each", () => {
    expect(moveTitle(mine, "me")).toBe("you ⇄ bo");
    expect(moveLines(mine, "me")).toEqual(["get D, 2027 1st", "give A"]);
  });

  it("says what each team gets where you are not in it", () => {
    expect(moveLines(pending, "me")).toEqual(["bo gets E", "cy gets C"]);
  });

  it("sums up what the odds include", () => {
    expect(whatIfSays(league, stateOf(NO_SCENARIO))).toBe("1 pending trade");
    expect(whatIfSays(league, stateOf({ ...NO_SCENARIO, moves: [mine], nudge: -0.1 })))
      .toBe("1 pending trade, 1 trade you added, your scoring −10%");
    expect(whatIfSays(league, stateOf(asItStands(league, { ...NO_SCENARIO, moves: [mine] })))).toBe("");
    expect(whatIfSays(league, stateOf({ ...NO_SCENARIO, moves: [mine], nudge: -0.1 }), true))
      .toBe("2 trades, you −10%");
  });
});

describe("the trades in the what-if", () => {
  it("list the league's pending trade, switched on, with no way to remove it", () => {
    const { where } = mount(NO_SCENARIO);

    expect(where.querySelector(".wiby")!.textContent).toBe("pending");
    expect(where.querySelector(".wiswitch")!.getAttribute("aria-checked")).toBe("true");
    expect(button(where, "remove")).toBeUndefined();
  });

  it("switch off with a tap and stay listed", () => {
    const { where, scenario } = mount(NO_SCENARIO);

    act(() => (where.querySelector(".wiswitch") as HTMLButtonElement).click());

    expect(scenario().off).toEqual(["league:9"]);
    expect(where.querySelector(".wiswitch")!.getAttribute("aria-checked")).toBe("false");
    expect(where.querySelectorAll(".wimoves li").length).toBe(1);
  });

  it("offer your own to edit or remove", () => {
    const edited: Move[] = [];
    const { where, scenario } = mount({ ...NO_SCENARIO, moves: [mine] }, (m) => edited.push(m));

    act(() => button(where, "edit").click());
    expect(edited).toEqual([mine]);

    act(() => button(where, "remove").click());
    expect(scenario().moves).toEqual([]);
  });

  it("say a trade whose player has moved on is skipped, and why", () => {
    const late: Move = { ...mine, id: "you:2", players: [{ ...p("c"), from: "bo", to: "me" }], picks: [] };
    const { where } = mount({ ...NO_SCENARIO, moves: [late] });

    expect(where.querySelector(".wistale")!.textContent).toBe("skipped: C isn't on bo's roster anymore");
  });
});

describe("the trade tab's what-if line", () => {
  it("says what the odds include, and opens to the trades", () => {
    const where = document.createElement("div");

    act(() => render(<WhatIfLine league={league} whatIf={stateOf(NO_SCENARIO)} />, where));

    expect(where.querySelector(".wisummary span")!.textContent).toBe("includes 1 trade");
    expect(where.querySelector(".wimoves")).toBeNull();

    act(() => (where.querySelector(".wisummary") as HTMLButtonElement).click());

    expect(where.querySelector(".wisummary")!.getAttribute("aria-expanded")).toBe("true");
    expect(where.querySelectorAll(".wimoves li").length).toBe(1);
  });

  it("draws nothing when there is nothing in the what-if", () => {
    const where = document.createElement("div");
    const empty = { ...league, pending: [] };

    render(
      <WhatIfLine
        league={empty}
        whatIf={{ scenario: NO_SCENARIO, world: scenarioLeague(empty, NO_SCENARIO), onScenario: () => {} }}
      />,
      where,
    );

    expect(where.innerHTML).toBe("");
  });
});

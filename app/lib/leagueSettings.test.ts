import { describe, expect, it } from "vitest";

import { readSettings, settingsSaid, withSettings } from "./leagueSettings.ts";
import type { League } from "./providers.ts";

const league = (over: Partial<League>): League =>
  ({ provider: "espn", leagueId: "1", size: 10, allRosters: [], ...over }) as League;

describe("league settings set by hand", () => {
  it("keeps only what still makes sense", () => {
    expect(readSettings({ lastRegularWeek: 3, tradeDeadline: 40, kind: "casual" })).toEqual({});
    expect(readSettings({ lastRegularWeek: 14, tradeDeadline: null, kind: "dynasty" }))
      .toEqual({ lastRegularWeek: 14, tradeDeadline: null, kind: "dynasty" });
    expect(readSettings("nonsense")).toEqual({});
  });

  it("lays what you set over what the provider sent", () => {
    const lg = withSettings(
      league({ lastRegularWeek: 14, keepers: false }),
      { tradeDeadline: 11, kind: "dynasty" },
    );

    expect(lg.tradeDeadline).toBe(11);
    expect(lg.lastRegularWeek).toBe(14);
    expect(lg.dynasty).toBe(true);
    expect(lg.keepers).toBe(true);
  });

  it("leaves the league alone where nothing is set", () => {
    const lg = league({ tradeDeadline: 12 });

    expect(withSettings(lg, {})).toEqual(lg);
  });

  it("tells a deadline the provider never said from one it said is none", () => {
    expect(settingsSaid(league({}), {}).tradeDeadline.known).toBe(false);
    expect(settingsSaid(league({ tradeDeadline: null }), {}).tradeDeadline.known).toBe(true);

    const mine = settingsSaid(league({ tradeDeadline: 12 }), { tradeDeadline: 10 }).tradeDeadline;

    expect(mine).toEqual({ value: 10, provider: 12, known: true, yours: true });
  });
});

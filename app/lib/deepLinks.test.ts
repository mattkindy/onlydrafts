import { describe, expect, it } from "vitest";

import { androidAppLink, lineupLink, onAndroid, playersLink } from "./deepLinks.ts";
import type { League } from "./providers.ts";

const league = (provider: League["provider"]) =>
  ({ provider, leagueId: "123", userId: "7", season: 2026 }) as League;

describe("a link to the provider's Android app", () => {
  it("addresses Sleeper's team page to Sleeper's app, with the web page to fall back on", () => {
    const web = lineupLink(league("sleeper"));

    expect(androidAppLink(web)).toBe(
      "intent://sleeper.com/leagues/123/team#Intent;scheme=https;package=com.sleeperbot;" +
        `S.browser_fallback_url=${encodeURIComponent(web)};end`,
    );
  });

  it("keeps ESPN's query, which says whose team it is", () => {
    const link = androidAppLink(playersLink(league("espn")))!;

    expect(link.startsWith(
      "intent://fantasy.espn.com/football/players/add?leagueId=123&seasonId=2026#Intent;")).toBe(true);
    expect(link).toContain("package=com.espn.fantasy.lm.football;");
  });

  it("leaves any other page alone", () => {
    expect(androidAppLink("https://example.com/x")).toBeNull();
    expect(androidAppLink("not a url")).toBeNull();
  });

  it("knows an Android phone by its user agent", () => {
    expect(onAndroid("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131")).toBe(true);
    expect(onAndroid("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)")).toBe(false);
  });
});

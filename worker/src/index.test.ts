import { afterEach, describe, expect, it } from "vitest";

import relay from "./index.ts";

const realFetch = globalThis.fetch;

const ask = () => relay.fetch(new Request(
  "https://relay.example/espn/12345?season=2026",
  { headers: { "x-espn-swid": "{A}", "x-espn-s2": "b" } },
));

describe("the ESPN relay", () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  it("returns 502 with the CORS headers when ESPN cannot be reached", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("timed out"))) as typeof fetch;

    const got = await ask();

    expect(got.status).toBe(502);
    expect(got.headers.get("access-control-allow-origin")).toBe("*");
    expect(await got.json()).toEqual({ error: "could not reach ESPN: timed out" });
  });

  it("passes on ESPN's 404 for a league it does not have", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;

    const got = await ask();

    expect(got.status).toBe(404);
    expect(got.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("reads a 403 as a cookie problem", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("", { status: 403 }))) as typeof fetch;

    const got = await ask();
    const said = await got.json() as { error: string };

    expect(got.status).toBe(403);
    expect(said.error).toContain("cookies");
  });
});

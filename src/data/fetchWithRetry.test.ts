import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry, isRetryableStatus } from "./fetchWithRetry.js";

/** a fetch that returns the next status on the list each time it is called */
function scripted(outcomes: (number | Error)[]) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    const next = outcomes.shift() ?? 200;

    if (next instanceof Error) {
      throw next;
    }

    return new Response(next === 204 ? null : `status ${next}`, {
      status: next,
    });
  }) as unknown as typeof fetch;

  return { calls, fetcher };
}

describe("fetchWithRetry", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});

  it("returns the first answer when it is fine", async () => {
    const { calls, fetcher } = scripted([200]);
    const sleep = vi.fn(async () => {});
    const response = await fetchWithRetry("u", { fetcher, sleep });

    expect(await response.text()).toBe("status 200");
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("tries again after a server error and a dropped connection", async () => {
    const { calls, fetcher } = scripted([503, new Error("reset"), 200]);
    const waits: number[] = [];
    const response = await fetchWithRetry("u", {
      fetcher, backoffMs: 10, sleep: async (ms) => { waits.push(ms); },
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([10, 20]);
  });

  it("hands a 404 back at once, since asking again gets the same", async () => {
    const { calls, fetcher } = scripted([404, 200]);
    const response = await fetchWithRetry("u", {
      fetcher, sleep: async () => {},
    });

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("returns the last server error once the retries run out", async () => {
    const { calls, fetcher } = scripted([500, 502, 503]);
    const response = await fetchWithRetry("u", {
      fetcher, retries: 2, sleep: async () => {},
    });

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it("throws when every attempt failed to connect", async () => {
    const { fetcher } = scripted([new Error("a"), new Error("b")]);

    await expect(fetchWithRetry("u", {
      fetcher, retries: 1, sleep: async () => {}, label: "the feed",
    })).rejects.toThrow("the feed: gave up after 2 attempts: b");
  });

  it("gives up on an attempt that hangs past the timeout", async () => {
    const hangs = ((_url: string, init?: RequestInit) =>
      new Promise((_done, fail) => {
        init?.signal?.addEventListener("abort", () => fail(new Error("hung")));
      })) as unknown as typeof fetch;

    await expect(fetchWithRetry("u", {
      fetcher: hangs, retries: 1, timeoutMs: 5, sleep: async () => {},
    })).rejects.toThrow("gave up after 2 attempts");
  });

  it("copes with a status that has no body", async () => {
    const { fetcher } = scripted([204]);
    const response = await fetchWithRetry("u", { fetcher });

    expect(response.status).toBe(204);
  });
});

describe("isRetryableStatus", () => {
  it("retries a timeout, a rate limit and a server error only", () => {
    expect([408, 429, 500, 503].every(isRetryableStatus)).toBe(true);
    expect([200, 301, 400, 403, 404].some(isRetryableStatus)).toBe(false);
  });
});

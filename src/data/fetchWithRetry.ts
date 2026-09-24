/**
 * A fetch that gives up on a hung request and tries again after a
 * failure that might not happen twice.
 *
 * The weekly refresh makes a few dozen requests, and any one of them
 * failing would stop the run. A request that times out, cannot connect, or comes back 408, 429 or 5xx
 * is tried again after a pause that doubles each time. Any other status
 * comes straight back to the caller, since a 404 is an answer and asking
 * again would only get it again.
 *
 * The body is read inside the attempt, so a download cut off halfway is
 * retried too, and the timeout covers the whole download. A caller
 * pulling a large file passes a longer timeout.
 */

export interface RetryOptions {
  /** how long one attempt may take, body included */
  timeoutMs?: number;
  /** how many times to try again after the first attempt */
  retries?: number;
  /** the pause before the first retry, doubled before each one after */
  backoffMs?: number;
  /** what to call it in the log when a retry happens */
  label?: string;
  init?: RequestInit;
  /** stand-ins for a test, so it neither goes online nor waits */
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  timeoutMs: 60_000,
  retries: 3,
  backoffMs: 1_000,
};

const pause = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

/** a status a server might not send if asked again a moment later */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * The response with its body already read, so reading it again cannot
 * fail on the network. A status that may not have a body gets none.
 */
async function buffered(response: Response): Promise<Response> {
  const body = await response.arrayBuffer();

  return new Response(body.byteLength === 0 ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function attempt(
  url: string, options: RetryOptions, timeoutMs: number,
): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.init?.signal
    ? AbortSignal.any([options.init.signal, timeout])
    : timeout;

  return buffered(await fetcher(url, { ...options.init, signal }));
}

export async function fetchWithRetry(
  url: string, options: RetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? DEFAULTS.retries;
  const backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const sleep = options.sleep ?? pause;
  const label = options.label ?? url;
  let lastError: unknown;

  for (let tried = 0; tried <= retries; tried++) {
    if (tried > 0) {
      await sleep(backoffMs * 2 ** (tried - 1));
    }

    const outcome = await attempt(url, options, timeoutMs).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );

    if ("error" in outcome) {
      lastError = outcome.error;
      console.warn(
        `${label}: attempt ${tried + 1} failed: ${describe(outcome.error)}`);
      continue;
    }

    const { response } = outcome;

    if (!isRetryableStatus(response.status) || tried === retries) {
      return response;
    }

    console.warn(`${label}: attempt ${tried + 1} returned ${response.status}`);
  }

  throw new Error(
    `${label}: gave up after ${retries + 1} attempts: ${describe(lastError)}`,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

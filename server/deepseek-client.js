/**
 * Shared DeepSeek HTTP client with retry + backoff.
 *
 * Both AI call sites in this server (the helper bot and AI moderation) talk
 * to the same endpoint — a Cloudflare Worker proxy in production
 * (DEEPSEEK_API_URL) or api.deepseek.com directly when DEEPSEEK_KEY is set.
 *
 * The proxy rate-limits, and the upstream occasionally returns 429 / 5xx.
 * Previously each call site bailed on the first non-OK response, which
 * silently dropped helper replies and disabled moderation (fail-open) for
 * the duration of the burst. This module retries the transient classes
 * (429, 408, 5xx, network errors) with exponential backoff + jitter, and
 * honours a `Retry-After` header when the server sends one.
 *
 * Non-retryable statuses (400, 401, 403, 404, 422) return immediately —
 * retrying a malformed request or a bad key just wastes time.
 */

/** Statuses worth retrying: transient server / rate-limit conditions. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Parse a `Retry-After` header (seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    if (delta > 0) return Math.min(delta, 30_000);
  }
  return null;
}

/** Exponential backoff with full jitter, capped at `maxDelayMs`. */
function backoffDelay(attempt, baseMs, maxDelayMs) {
  const exp = Math.min(baseMs * 2 ** attempt, maxDelayMs);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * POST JSON to the DeepSeek endpoint with retry on transient failures.
 *
 * Returns one of:
 *   { ok: true,  status, data, response }
 *   { ok: false, status, error, body, retryable, response? }
 *
 * Never throws for HTTP status problems; throws only if the caller's
 * AbortSignal fires (AbortError), which callers already handle.
 *
 * @param {object}   opts
 * @param {string}   opts.url        Endpoint URL.
 * @param {object}   opts.headers    Request headers.
 * @param {object}   opts.body       JSON-serialisable request body.
 * @param {AbortSignal} [opts.signal] Caller cancellation.
 * @param {string}   [opts.tag]      Log prefix, e.g. 'helper-bot'.
 * @param {number}   [opts.maxAttempts=3]
 * @param {number}   [opts.baseDelayMs=400]
 * @param {number}   [opts.maxDelayMs=8000]
 * @param {boolean}  [opts.stream=false] When true, return the raw Response on
 *                                   success so the caller can consume the body.
 */
export async function deepseekFetch({
  url,
  headers = {},
  body,
  signal,
  tag = 'deepseek',
  maxAttempts = 3,
  baseDelayMs = 400,
  maxDelayMs = 8000,
  stream = false,
} = {}) {
  if (!url) return { ok: false, status: 0, error: 'no-endpoint', retryable: false };

  let last = { ok: false, status: 0, error: 'unknown', retryable: false };

  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt++) {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Caller cancellation — propagate, do not retry.
      if (err?.name === 'AbortError' || signal?.aborted) throw err;

      const code = err?.cause?.code || err?.code || '';
      const retryable = !code || RETRYABLE_ERROR_CODES.has(code);
      last = { ok: false, status: 0, error: err?.message || String(err), retryable };
      if (!retryable || attempt === maxAttempts - 1) {
        console.warn(`[${tag}] network error (attempt ${attempt + 1}/${maxAttempts}):`, last.error);
        return last;
      }
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      console.warn(`[${tag}] network error (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms:`, last.error);
      await sleep(delay, signal);
      continue;
    }

    if (resp.ok) {
      if (stream) return { ok: true, status: resp.status, response: resp };
      let data;
      try {
        data = await resp.json();
      } catch (err) {
        last = { ok: false, status: resp.status, error: 'invalid-json', retryable: true };
        if (attempt === maxAttempts - 1) return last;
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs), signal);
        continue;
      }
      return { ok: true, status: resp.status, data, response: resp };
    }

    const retryable = RETRYABLE_STATUS.has(resp.status);
    const bodyText = await resp.text().catch(() => '');
    last = {
      ok: false,
      status: resp.status,
      error: `HTTP ${resp.status}`,
      body: bodyText.slice(0, 200),
      retryable,
      response: resp,
    };

    if (!retryable || attempt === maxAttempts - 1) {
      console.warn(`[${tag}] giving up: HTTP ${resp.status} ${last.body}`);
      return last;
    }

    const retryAfter = parseRetryAfter(resp.headers?.get?.('retry-after'));
    const delay = retryAfter ?? backoffDelay(attempt, baseDelayMs, maxDelayMs);
    console.warn(`[${tag}] HTTP ${resp.status} (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms`);
    await sleep(delay, signal);
  }

  return last;
}

export { RETRYABLE_STATUS, parseRetryAfter, backoffDelay };

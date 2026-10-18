/**
 * Fetch for release inputs. A server error, rate limit or connection failure is retried with
 * backoff; any other response is returned at once, so a missing source still fails immediately.
 * A timeout already costs minutes, so it is retried once only, keeping a hung host inside the
 * CI job limit. Every retry is reported, so a slow build can be traced to its source.
 * `init` is a function because an abort signal cannot be reused across attempts.
 * `consume` must finish reading and verifying the body before an attempt succeeds.
 */
export async function fetchRetry(url, init, {
  attempts = 4, wait = ms => new Promise(done => setTimeout(done, ms)), request = fetch, report = console.error,
  consume = response => response,
} = {}) {
  let timeouts = 0;
  for (let attempt = 1; ; attempt += 1) {
    let response;
    let failure;
    try {
      response = await request(url, init());
      if (response.ok) return await consume(response);
    } catch (error) {
      failure = error;
    }
    if (!failure && response && response.status !== 429 && response.status < 500) return consume(response);
    const timedOut = failure?.name === "TimeoutError" || failure?.name === "AbortError";
    if (timedOut) timeouts += 1;
    if (attempt === attempts || timeouts > 1) {
      if (failure) throw failure;
      return consume(response);
    }
    // Consumption may already have errored or locked the body. Cleanup must not
    // replace that failure or prevent the next attempt.
    if (response?.body && !response.body.locked) {
      await response.body.cancel().catch(() => {});
    }
    const delay = 1000 * 2 ** (attempt - 1);
    report(`Retrying ${url} in ${delay} ms after ${failure ? failure.name : `HTTP ${response.status}`} (attempt ${attempt} of ${attempts})`);
    await wait(delay);
  }
}

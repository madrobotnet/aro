/**
 * Fetch for release inputs. A server error, rate limit or connection failure is retried with
 * backoff; any other response is returned at once, so a missing source still fails immediately.
 * `init` is a function because an abort signal cannot be reused across attempts.
 */
export async function fetchRetry(url, init, { attempts = 4, wait = ms => new Promise(done => setTimeout(done, ms)), request = fetch } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    let failure;
    try {
      response = await request(url, init());
    } catch (error) {
      failure = error;
    }
    if (response && response.status !== 429 && response.status < 500) return response;
    if (attempt === attempts) {
      if (failure) throw failure;
      return response;
    }
    await response?.body?.cancel();
    await wait(1000 * 2 ** (attempt - 1));
  }
}

/**
 * Hard guard for the test suite: a real network request must never happen.
 *
 * Every paid API in this project (Serper search/news, OpenRouter models,
 * Firecrawl, Telegram) is reached through `fetch`. Tests must inject a
 * `fetchFn` (and a `lookupFn` for DNS); if one forgets, this stub fails the
 * test immediately instead of spending credits or depending on the network.
 *
 * Live checks deliberately live OUTSIDE `npm test`:
 *  - `backend/scripts/news-compare.ts` (Serper credits, run manually),
 *  - `test/evals/nightly.ts` (LLM judge scaffold, not part of the gate).
 */
import { afterAll, beforeEach } from "vitest";

const realFetch = globalThis.fetch;

function blockedFetch(): never {
  throw new Error(
    "Tests must not perform real network requests: inject `fetchFn` (and `lookupFn`). " +
      "Paid APIs (Serper/OpenRouter/Firecrawl) are off-limits inside `npm test`.",
  );
}

function installStub(): void {
  globalThis.fetch = (async () => blockedFetch()) as typeof globalThis.fetch;
}

installStub();

beforeEach(installStub);

afterAll(() => {
  globalThis.fetch = realFetch;
});

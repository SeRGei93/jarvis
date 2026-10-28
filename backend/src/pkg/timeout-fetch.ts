/**
 * `fetch` with an HTTP timeout, composed with any caller-supplied abort signal.
 *
 * Every outbound HTTP client in the app (LLM providers, the OpenRouter catalog,
 * Serper, the decision transport) must bound its own request: Mastra/AI SDK have
 * no timeout of their own and a hung socket would otherwise stall a chat turn.
 * The caller's `init.signal` is preserved (agent watchdog / tool abort).
 */
export function timeoutFetch(
  ms: number,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return baseFetch(input, { ...init, signal });
  };
}

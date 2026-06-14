import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createXai } from "@ai-sdk/xai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { env } from "../config/env.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "models" });

export type Provider = "openrouter" | "zai" | "xai" | "openai" | "google";

const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
const DEFAULT_HTTP_TIMEOUT_MS = 300_000;

/** Split a `provider:model` ref on the first colon. No prefix -> openrouter (Go parity). */
export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const idx = ref.indexOf(":");
  if (idx === -1) return { provider: "openrouter", modelId: ref };
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

export interface ModelFactoryOptions {
  /** Applied to compat providers (openrouter/zai/xai); openai/google use SDK defaults. */
  httpTimeoutMs?: number;
  /** Override API keys (defaults read from env). */
  apiKeys?: Partial<Record<Provider, string | undefined>>;
}

/** fetch wrapped with an HTTP timeout, composed with any caller-supplied abort signal. */
function timeoutFetch(ms: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal });
  };
}

/**
 * Resolves a `provider:model` string to an AI SDK LanguageModel. Providers are
 * created lazily and memoized. Compat providers get an HTTP-client timeout
 * (= settings.timeouts.http_client) so HTTP aborts no earlier than the watchdog.
 */
export class ModelFactory {
  private readonly httpFetch: typeof fetch;
  private readonly keys: Record<Provider, string | undefined>;
  private readonly cache = new Map<Provider, (id: string) => LanguageModel>();

  constructor(opts: ModelFactoryOptions = {}) {
    this.httpFetch = timeoutFetch(opts.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
    this.keys = {
      openrouter: opts.apiKeys?.openrouter ?? env.OPENROUTER_API_KEY,
      zai: opts.apiKeys?.zai ?? env.ZAI_API_KEY,
      xai: opts.apiKeys?.xai ?? env.XAI_API_KEY,
      openai: opts.apiKeys?.openai ?? env.OPENAI_API_KEY,
      google: opts.apiKeys?.google ?? env.GOOGLE_API_KEY,
    };
  }

  model(ref: string): LanguageModel {
    const { provider, modelId } = parseModelRef(ref);
    log.debug({ provider, modelId }, "resolving model");
    const build = this.providerFor(provider as Provider);
    return build(modelId);
  }

  private providerFor(provider: Provider): (id: string) => LanguageModel {
    const cached = this.cache.get(provider);
    if (cached) return cached;

    let build: (id: string) => LanguageModel;
    switch (provider) {
      case "openrouter": {
        const p = createOpenRouter({ apiKey: this.keys.openrouter, fetch: this.httpFetch });
        build = (id) => p(id);
        break;
      }
      case "zai": {
        const p = createOpenAICompatible({
          name: "zai",
          baseURL: ZAI_BASE_URL,
          apiKey: this.keys.zai,
          fetch: this.httpFetch,
        });
        build = (id) => p(id);
        break;
      }
      case "xai": {
        const p = createXai({ apiKey: this.keys.xai, fetch: this.httpFetch });
        build = (id) => p(id);
        break;
      }
      case "openai": {
        const p = createOpenAI({ apiKey: this.keys.openai });
        build = (id) => p(id);
        break;
      }
      case "google": {
        const p = createGoogleGenerativeAI({ apiKey: this.keys.google });
        build = (id) => p(id);
        break;
      }
      default:
        log.error({ provider }, "unknown provider");
        throw new Error(`unknown provider: ${provider}`);
    }
    this.cache.set(provider, build);
    return build;
  }
}

import { describe, it, expect, vi } from "vitest";
import {
  DecisionService,
  MAX_STATE_CHARS,
  stripProviderPrefix,
  type DecisionServiceOptions,
} from "../../src/mastra/decisions/service.js";
import type { DecisionAnswer, DecisionClient } from "../../src/mastra/decisions/types.js";
import type { SettingsService } from "../../src/config/settings.js";

function fakeSettings(decision: string | undefined): SettingsService {
  return {
    getModelRoles: async () => ({
      default: "openrouter:d",
      router: "openrouter:r",
      error_correction: "",
      speech: "",
      synthesizer: "",
      decision,
    }),
  } as unknown as SettingsService;
}

/** Client that returns a canned answer and records the calls it served. */
function fakeClient(
  answer: DecisionAnswer | null,
  opts: { throws?: boolean } = {},
): DecisionClient & { calls: Array<{ state: string; questions: unknown }> } {
  const calls: Array<{ state: string; questions: unknown }> = [];
  return {
    calls,
    decide: async (state, questions) => {
      calls.push({ state, questions });
      if (opts.throws) throw new Error("network down");
      return { answers: answer ? { q: answer } : {}, inputTokens: 12 };
    },
  };
}

const service = (decision: string | undefined, client: DecisionClient | null, over: DecisionServiceOptions = {}) =>
  new DecisionService(fakeSettings(decision), { client: client ?? undefined, ...over });

const CRITERIA = { weather: "погода", research: "поиск" };

describe("stripProviderPrefix", () => {
  it("drops only the openrouter: prefix", () => {
    expect(stripProviderPrefix("openrouter:cloudflare/clef")).toBe("cloudflare/clef");
    expect(stripProviderPrefix("cloudflare/clef")).toBe("cloudflare/clef");
    expect(stripProviderPrefix("~perplexity/pplx-decider-latest")).toBe("~perplexity/pplx-decider-latest");
  });
});

describe("DecisionService.choose", () => {
  it("returns the chosen option and probabilities", async () => {
    const client = fakeClient({
      type: "choice",
      choice: "weather",
      probabilities: { weather: 0.93, research: 0.07 },
    });
    const out = await service("openrouter:~perplexity/pplx-decider-latest", client).choose(
      "какая погода?",
      "pick a skill",
      CRITERIA,
    );
    expect(out).toEqual({ choice: "weather", probabilities: { weather: 0.93, research: 0.07 } });
    expect(client.calls).toHaveLength(1);
  });

  it("returns null when the model refuses", async () => {
    const client = fakeClient({ type: "refusal" });
    expect(await service("openrouter:cloudflare/clef", client).choose("x", "i", CRITERIA)).toBeNull();
  });

  it("returns null when the answer carries no probabilities", async () => {
    const client = fakeClient({ type: "choice", choice: "weather" });
    expect(await service("openrouter:cloudflare/clef", client).choose("x", "i", CRITERIA)).toBeNull();
  });

  it("returns null when the call throws", async () => {
    const client = fakeClient(null, { throws: true });
    expect(await service("openrouter:cloudflare/clef", client).choose("x", "i", CRITERIA)).toBeNull();
  });

  it("returns null for an option outside the criteria", async () => {
    const client = fakeClient({ type: "choice", choice: "not-an-option" });
    expect(await service("openrouter:cloudflare/clef", client).choose("x", "i", CRITERIA)).toBeNull();
  });

  it("does not call the model with empty criteria (the API 422s)", async () => {
    const client = fakeClient({ type: "choice", choice: "weather" });
    expect(await service("openrouter:cloudflare/clef", client).choose("x", "i", {})).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  it("is off when the decision role is empty (no call)", async () => {
    const client = fakeClient({ type: "choice", choice: "weather" });
    expect(await service("", client).choose("x", "i", CRITERIA)).toBeNull();
    expect(await service(undefined, client).isEnabled()).toBe(false);
    expect(client.calls).toHaveLength(0);
  });

  it("rejects a non-OpenRouter ref without a call (System One is OpenRouter-only)", async () => {
    const client = fakeClient({ type: "choice", choice: "weather" });
    expect(await service("zai:glm-5", client).choose("x", "i", CRITERIA)).toBeNull();
    expect(client.calls).toHaveLength(0);
  });
});

describe("DecisionService.judge", () => {
  it("returns P(yes) for a boolean question", async () => {
    const client = fakeClient({ type: "boolean", probability: 0.83 });
    expect(await service("openrouter:cloudflare/clef", client).judge("same fact?", "dup?")).toBe(0.83);
  });

  it("returns null when the answer is not boolean", async () => {
    const client = fakeClient({ type: "choice", choice: "weather" });
    expect(await service("openrouter:cloudflare/clef", client).judge("x", "y")).toBeNull();
  });
});

describe("DecisionService state budget", () => {
  it("truncates the state to MAX_STATE_CHARS before the call", async () => {
    const client = fakeClient({ type: "boolean", probability: 0.1 });
    const huge = "ф".repeat(MAX_STATE_CHARS + 5_000);
    await service("openrouter:cloudflare/clef", client).judge(huge, "q");
    expect(client.calls[0]!.state).toHaveLength(MAX_STATE_CHARS);
  });

  it("sends the state unchanged when it already fits", async () => {
    const client = fakeClient({ type: "boolean", probability: 0.1 });
    await service("openrouter:cloudflare/clef", client).judge("short", "q");
    expect(client.calls[0]!.state).toBe("short");
  });
});

describe("DecisionService client construction", () => {
  it("uses the injected factory for the configured ref", async () => {
    const factory = vi.fn(() => fakeClient({ type: "boolean", probability: 0.5 }));
    const svc = new DecisionService(fakeSettings("openrouter:vendor/model"), { factory });
    expect(await svc.judge("x", "y")).toBe(0.5);
    expect(factory).toHaveBeenCalledWith("openrouter:vendor/model");
  });

  it("memoises the client and rebuilds it when the role changes", async () => {
    let ref = "openrouter:a/one";
    const settings = {
      getModelRoles: async () => ({
        default: "",
        router: "",
        error_correction: "",
        speech: "",
        synthesizer: "",
        decision: ref,
      }),
    } as unknown as SettingsService;
    const factory = vi.fn(() => fakeClient({ type: "boolean", probability: 0.4 }));
    const svc = new DecisionService(settings, { factory });

    await svc.judge("x", "q");
    await svc.judge("x", "q");
    expect(factory).toHaveBeenCalledTimes(1);

    ref = "openrouter:b/two";
    await svc.judge("x", "q");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("falls back to null when the factory throws", async () => {
    const svc = new DecisionService(fakeSettings("openrouter:bad/ref"), {
      factory: () => {
        throw new Error("no key");
      },
    });
    expect(await svc.judge("x", "q")).toBeNull();
  });
});

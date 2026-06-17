/**
 * Phase 0 de-risk spike (task S1). Throwaway PoC proving the five go/no-go
 * decisions behind the Mastra-`Agent` orchestrator move (plan decisions #2/#4):
 *
 *   (a) instructions/model/tools are resolved per-request from SettingsService,
 *       NOT baked into the constructor (keeps DI + DB-backed config);
 *   (b) the whole thing runs in a unit test against a mock model, no network;
 *   (c) the model is an instance produced by `factory.model(ref)` and can change
 *       per request (read from the RequestContext);
 *   (d) progressive tool exposure works: ALL skill tools are registered up front,
 *       but the live set is gated per step via `prepareStep` -> `activeTools`,
 *       and the gate widens after `load_skill` mutates the loaded-skill set
 *       (this is the linchpin for the future `load_skill` tool, decision #2);
 *   (e) `stripLeakedToolCalls` survives the move — both as a post-stream step
 *       (parity with `llm.ts:195`) and the agent's output-processor pipeline runs.
 *
 * NOT production code: prefixed `_spike-`, excluded from the orchestrator wiring.
 * Delete once A4 lands the real orchestrator. See .ai-factory/plans/mastra-adoption.md.
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { RequestContext } from "@mastra/core/request-context";
import type { OutputProcessor } from "@mastra/core/processors";
import type { MastraModelConfig } from "@mastra/core/llm";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { stripLeakedToolCalls } from "../strip-leaked-tools.js";
import { logger } from "../../pkg/logger.js";
import type { SettingsService } from "../../config/settings.js";

const log = logger.child({ mod: "spike-orchestrator" });

/** Per-request state carried via Mastra's RequestContext. */
export interface SpikeReqValues {
  /** `provider:model` ref resolved through the factory for THIS request (check c). */
  modelRef: string;
  /** Skill chosen by the pre-pass; pre-loaded into the gate before step 1. */
  primarySkill: string;
  /** Mutable set of loaded skills; `load_skill` widens it, `prepareStep` reads it (check d). */
  loadedSkills: Set<string>;
}

/** Minimal model resolver — `ModelFactory` satisfies this; tests inject a fake (check b). */
export interface SpikeModelResolver {
  model(ref: string): LanguageModel;
}

export interface SpikeDeps {
  factory: SpikeModelResolver;
  /** Only the per-request config the spike touches (check a). */
  settings: Pick<SettingsService, "getModelRoles" | "getAgent">;
}

/**
 * Spike skill -> tool-name map, standing in for the real `*_TOOL_NAMES` registry
 * (A2). `load_skill` is always active; everything else is gated until its skill loads.
 */
const SPIKE_SKILL_TOOLS: Record<string, readonly string[]> = {
  research: ["web_search"],
  currency: ["currency_rates"],
};

/** Active tool names for the current loaded-skill set (load_skill is always on). */
function activeToolsFor(loadedSkills: ReadonlySet<string>): string[] {
  const names = new Set<string>(["load_skill"]);
  for (const skill of loadedSkills) {
    for (const t of SPIKE_SKILL_TOOLS[skill] ?? []) names.add(t);
  }
  return [...names];
}

/**
 * Builds the standalone dynamic Agent ONCE (not registered on a Mastra instance).
 * `instructions`/`model`/`tools` are functions of the request context: config is
 * pulled live from SettingsService and the model from the factory (checks a + c).
 */
export function createSpikeOrchestrator(deps: SpikeDeps): Agent {
  const loadSkill = createTool({
    id: "load_skill",
    description: "Load a skill's instructions and activate its tools.",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ loaded: z.string(), tools: z.array(z.string()) }),
    execute: async ({ name }, { requestContext }) => {
      const loaded = requestContext?.get("loadedSkills") as Set<string> | undefined;
      loaded?.add(name);
      const tools = SPIKE_SKILL_TOOLS[name] ?? [];
      log.debug({ name, tools }, "load_skill invoked");
      return { loaded: name, tools: [...tools] };
    },
  });

  const webSearch = createTool({
    id: "web_search",
    description: "Search the web (spike stub).",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ results: z.string() }),
    execute: async ({ query }) => ({ results: `stub results for ${query}` }),
  });

  const currencyRates = createTool({
    id: "currency_rates",
    description: "Get currency rates (spike stub).",
    inputSchema: z.object({}),
    outputSchema: z.object({ rates: z.string() }),
    execute: async () => ({ rates: "stub rates" }),
  });

  return new Agent({
    id: "spike-orchestrator",
    name: "spike-orchestrator",
    instructions: async ({ requestContext }) => {
      // (a) config from SettingsService, resolved per request — not the constructor.
      const roles = await deps.settings.getModelRoles();
      const agentCfg = await deps.settings.getAgent();
      const primary = (requestContext?.get("primarySkill") as string | undefined) ?? "";
      return [
        "You are the Jarvis orchestrator (spike).",
        `default-model-role=${roles.default}`,
        `max-history=${agentCfg.max_history}`,
        `primary-skill=${primary}`,
      ].join("\n");
    },
    // (c) model is a factory-produced instance, chosen per request from the context.
    model: ({ requestContext }) => {
      const ref = (requestContext?.get("modelRef") as string | undefined) ?? "";
      // Cast bridges two bundled `LanguageModelV2` declarations (ai vs @mastra/core);
      // the runtime object IS what Mastra expects. ModelFactory stays the source of truth.
      return deps.factory.model(ref) as MastraModelConfig;
    },
    // (d/A2) ALL skill tools registered up front; the live set is gated per step.
    tools: { load_skill: loadSkill, web_search: webSearch, currency_rates: currencyRates },
  });
}

export interface SpikeRunInput {
  userMessage: string;
  modelRef: string;
  primarySkill: string;
  abortSignal?: AbortSignal;
  onText?: (accumulatedText: string) => void;
}

export interface SpikeRunResult {
  text: string;
  /** How many leaked tool-calls the post-stream strip removed (check e). */
  stripped: number;
  /** Proof the agent's output-processor pipeline ran under `agent.stream` (check e). */
  processorRan: boolean;
  /** `activeTools` computed at each step — should widen after `load_skill` (check d). */
  activeToolsPerStep: string[][];
}

/**
 * Streams one turn through the spike agent. Carries per-request state via
 * RequestContext, gates tools per step with `prepareStep`, keeps our own
 * AbortSignal watchdog (Mastra has no built-in timeout), runs an output
 * processor, and strips leaked tool-calls post-stream.
 */
export async function runSpike(agent: Agent, input: SpikeRunInput): Promise<SpikeRunResult> {
  const loadedSkills = new Set<string>([input.primarySkill]);
  const requestContext = new RequestContext<SpikeReqValues>([
    ["modelRef", input.modelRef],
    ["primarySkill", input.primarySkill],
    ["loadedSkills", loadedSkills],
  ]);

  const activeToolsPerStep: string[][] = [];
  let processorRan = false;

  const stripProcessor: OutputProcessor = {
    id: "strip-leaked-tools",
    processOutputStream: async ({ part }) => {
      processorRan = true;
      return part;
    },
  };

  const out = await agent.stream([{ role: "user", content: input.userMessage }], {
    requestContext,
    abortSignal: input.abortSignal,
    // Orchestrator does more tool-steps per turn (load_skill + skill tools); raise the cap.
    maxSteps: 50,
    // (d) recompute the live tool set each step from the (mutating) loaded-skill set.
    prepareStep: () => {
      const active = activeToolsFor(loadedSkills);
      activeToolsPerStep.push(active);
      return { activeTools: active };
    },
    outputProcessors: [stripProcessor],
  });

  let acc = "";
  for await (const delta of out.textStream) {
    acc += delta;
    input.onText?.(acc);
  }

  // (e) parity with llm.ts:195 — strip leaked tool-calls off the accumulated stream.
  const { text, stripped } = stripLeakedToolCalls(acc);
  log.debug({ stripped, processorRan, steps: activeToolsPerStep.length }, "spike run done");
  return { text, stripped, processorRan, activeToolsPerStep };
}

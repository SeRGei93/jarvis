import type { MemoryScope } from "./entities.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "memory-classifier" });

// Session keywords = reliable temporary-context markers (Go memory_classifier.go).
// NB: bare verbs like "пишу"/"делаю" are intentionally excluded — they false-positive
// on durable facts like "пишет на Go".
const SESSION_KEYWORDS = [
  // explicit temporal markers
  "сейчас",
  "в данный момент",
  "на данный момент",
  "в настоящее время",
  "текущий",
  "текущая",
  "текущее",
  "сегодня",
  "на этой неделе",
  "в этом месяце",
  "временно",
  // working on specific tasks (phrase-level)
  "работаю над",
  "работает над",
  "работаю с проектом",
  "работает с проектом",
  "решаю задачу",
  "решает задачу",
  // debugging/fixing (inherently temporary)
  "рефакторю",
  "рефакторит",
  "исправляю",
  "исправляет",
  "отлаживаю",
  "отлаживает",
  // conversation context
  "обсуждаем",
  "обсуждает",
  "говорим о",
  "говорит о",
  "спрашивает о",
];

/**
 * Classify a memory's scope (parity with Go MemoryClassifier.ClassifyScope):
 * everything except `fact` is permanent; a `fact` is `session` only if its content
 * contains a temporary-context keyword.
 */
export function classifyScope(category: string, content: string): MemoryScope {
  if (category !== "fact") return "permanent";
  const lower = content.toLowerCase();
  for (const kw of SESSION_KEYWORDS) {
    if (lower.includes(kw)) {
      log.debug({ matched: kw }, "classified fact as session");
      return "session";
    }
  }
  return "permanent";
}

/**
 * Deterministic routing fixtures for the B4 eval harness (offline, no model).
 *
 * Each fixture pairs a user message with the primary skill the A3 pre-pass
 * (`PrimarySkillSelector`) is expected to choose. The blocking gate scores a
 * CHOSEN skill against the EXPECTED one with `primarySkillChoice` — it never
 * calls the real LLM classifier, so the corpus is a frozen ground-truth set
 * used to spot routing regressions without spending tokens.
 *
 * Skill names mirror `skills/<name>/SKILL.md`. The bot is RU-first, so the
 * corpus mixes Russian and English messages.
 */

/** Skill names that are routable as a turn's primary skill (mirror `skills/`). */
export type SkillName =
  | "research"
  | "currency"
  | "weather"
  | "cars"
  | "news"
  | "jobs"
  | "realty"
  | "shopping"
  | "health"
  | "leisure"
  | "transport"
  | "translate"
  | "remember"
  | "onboarding"
  | "chat";

/** One routing test case: a user message and the skill that should lead the turn. */
export interface RoutingFixture {
  /** Stable identifier for assertion messages and per-case reporting. */
  id: string;
  /** The raw inbound user message (untrusted in production; static here). */
  userMessage: string;
  /** The primary skill the pre-pass is expected to pick. */
  expectedSkill: SkillName;
  /** BCP-47-ish language tag of the message, for coverage reporting. */
  lang?: "ru" | "en";
}

/**
 * ~15 fixtures spanning the routable skill set, RU/EN mixed. Kept deterministic:
 * the harness compares an externally supplied chosen skill to `expectedSkill`.
 */
export const ROUTING_FIXTURES: readonly RoutingFixture[] = [
  {
    id: "currency-ru",
    userMessage: "Сколько стоит доллар сегодня?",
    expectedSkill: "currency",
    lang: "ru",
  },
  {
    id: "weather-en",
    userMessage: "What's the weather in Minsk tomorrow?",
    expectedSkill: "weather",
    lang: "en",
  },
  {
    id: "cars-ru",
    userMessage: "Найди подержанный BMW X5 до 30000 долларов",
    expectedSkill: "cars",
    lang: "ru",
  },
  {
    id: "news-ru",
    userMessage: "Какие последние новости про искусственный интеллект?",
    expectedSkill: "news",
    lang: "ru",
  },
  {
    id: "news-world-ru",
    userMessage: "Посмотри новости про утренний удар по Москве",
    expectedSkill: "news",
    lang: "ru",
  },
  {
    id: "jobs-en",
    userMessage: "Find me backend developer vacancies in Minsk",
    expectedSkill: "jobs",
    lang: "en",
  },
  {
    id: "realty-ru",
    userMessage: "Хочу снять двухкомнатную квартиру в Минске",
    expectedSkill: "realty",
    lang: "ru",
  },
  {
    id: "shopping-ru",
    userMessage: "Где купить недорого iPhone 16 и сравнить цены?",
    expectedSkill: "shopping",
    lang: "ru",
  },
  {
    id: "health-ru",
    userMessage: "Подскажи хорошего стоматолога в Минске",
    expectedSkill: "health",
    lang: "ru",
  },
  {
    id: "leisure-ru",
    userMessage: "Куда сходить на выходных, какие концерты в городе?",
    expectedSkill: "leisure",
    lang: "ru",
  },
  {
    id: "transport-ru",
    userMessage: "Когда ближайший автобус номер 100?",
    expectedSkill: "transport",
    lang: "ru",
  },
  {
    id: "translate-en",
    userMessage: "Translate 'good morning' into Spanish",
    expectedSkill: "translate",
    lang: "en",
  },
  {
    id: "translate-ru",
    userMessage: "Переведи это предложение на английский",
    expectedSkill: "translate",
    lang: "ru",
  },
  {
    id: "remember-ru",
    userMessage: "Запомни, что я живу в Гомеле",
    expectedSkill: "remember",
    lang: "ru",
  },
  {
    id: "research-en",
    userMessage: "Research the history of the Hanseatic League",
    expectedSkill: "research",
    lang: "en",
  },
  {
    id: "chat-ru",
    userMessage: "Привет, как дела?",
    expectedSkill: "chat",
    lang: "ru",
  },
] as const;

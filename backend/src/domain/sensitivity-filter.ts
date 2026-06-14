import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "sensitivity-filter" });

// Deliberately broad list — we'd rather drop a borderline memory than store harmful
// or highly sensitive content. Port of Go memory_sensitivity_filter.go.
const SENSITIVE_KEYWORDS = [
  // Illegal activity
  "наркотик", "наркота", "нарко", "drug", "drugs",
  "продажа органов", "продажей органов", "торговля органами", "organ trafficking",
  "organ selling", "sell organs", "organs",
  "оружие", "weapon", "firearms", "взрывчатка", "explosive",
  "кража", "хищение", "theft", "steal", "stealing",
  "мошенничество", "fraud", "scam", "обман",
  "взлом", "hacking", "hack", "crack",
  "отмывание", "money laundering",
  "контрабанда", "smuggling",
  "убийство", "murder", "killing",
  "нелегально", "illegal", "illicit",
  "преступление", "crime", "criminal",
  // Self-harm and suicide
  "суицид", "suicide", "самоубийство",
  "самоповреждение", "self-harm", "self harm",
  "порезать себя", "cut myself",
  "умереть", "want to die",
  // Violence and threats
  "насилие", "violence", "violent",
  "угроза", "threat",
  "терроризм", "terrorism", "terrorist",
  "экстремизм", "extremism",
  // Exploitation
  "педофили", "pedophil", "child abuse",
  "эксплуатация", "exploitation",
  "торговля людьми", "human trafficking",
  // Personal crises and vulnerabilities
  "депрессия", "depression",
  "тревожность", "anxiety disorder",
  "психоз", "psychosis",
  "зависимость", "addiction", "addicted",
  "алкоголизм", "alcoholism",
  "наркомания",
  // Personal medical data
  "диагноз", "diagnosis",
  "болезнь", "illness", "disease",
  "инвалидность", "disability",
  "хроническ", "chronic",
  "лечение", "treatment", "therapy",
  "операция", "surgery",
  "онкология", "cancer", "tumor",
  "вич", "hiv", "aids",
  "психиатр", "psychiatrist",
  "психолог", "psychologist",
  "антидепрессант", "antidepressant",
  // Financial distress
  "банкротств", "bankruptcy",
  "долги", "debt",
  "коллектор", "debt collector",
  "кредит просроч", "overdue loan",
  // Family / personal crises
  "развод", "divorce",
  "измена", "cheating", "affair",
  "домашнее насилие", "domestic violence",
  "насилие в семье",
  "потеря работы", "lost job", "fired",
  "тюрьма", "prison", "jail", "arrested",
  "судимость", "convicted",
  "конфликт с законом",
  // Sexual orientation / gender (personal information)
  "сексуальная ориентация", "sexual orientation",
  "каминг-аут", "coming out",
  "трансгендер", "transgender",
  // Religious extremism / cults
  "секта", "cult",
  "радикальный", "radical", "radicalized",
];

/** True if content contains a sensitive topic (parity with Go MemorySensitivityFilter). */
export function isSensitive(content: string): boolean {
  const lower = content.toLowerCase();
  for (const kw of SENSITIVE_KEYWORDS) {
    if (lower.includes(kw)) {
      log.debug({ matched: kw }, "sensitive content matched");
      return true;
    }
  }
  return false;
}

import { generateObject } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import { users, botIdentities } from "../../db/schema.js";
import type { Message } from "../../domain/entities.js";
import { ModelFactory } from "../models.js";
import { SettingsService } from "../../config/settings.js";
import {
  sanitizeProfileField,
  validateTimezone,
  validateLanguage,
} from "../../pkg/promptguard.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "profile-extractor" });

type Db = LibSQLDatabase<typeof schema>;

const ProfileSchema = z.object({
  name: z.string().default(""),
  city: z.string().default(""),
  timezone: z.string().default(""), // IANA
  language: z.string().default(""), // ISO 639-1
  bot_name: z.string().default(""),
  vibe: z.string().default(""),
});
export type ProfileData = z.infer<typeof ProfileSchema>;

const SYSTEM_PROMPT = [
  "Extract the user's profile from the conversation.",
  "Fields: name (as introduced), city of residence, timezone (IANA, derived from city),",
  "language (ISO 639-1), bot_name (the name the user gave the assistant),",
  "vibe (preferred communication style, short phrase in the user's language).",
  "Leave a field empty if it is not clearly stated.",
].join(" ");

export interface UserProfileFields {
  name: string;
  displayName: string;
  city: string;
  timezone: string;
  language: string;
}

/** Merge an extracted profile into user fields — only fill EMPTY fields; sanitize/validate. */
export function mergeProfileIntoUser(current: UserProfileFields, p: ProfileData): UserProfileFields {
  const out = { ...current };
  if (!out.name && p.name) {
    out.name = sanitizeProfileField(p.name);
    if (!out.displayName) out.displayName = out.name;
  }
  if (!out.city && p.city) out.city = sanitizeProfileField(p.city);
  if (!out.timezone && p.timezone && validateTimezone(p.timezone)) out.timezone = p.timezone.trim();
  if (!out.language && p.language && validateLanguage(p.language)) {
    out.language = p.language.trim().toLowerCase();
  }
  return out;
}

/** Injectable extraction call (tests). */
export type ExtractFn = (modelRef: string, messages: Message[]) => Promise<ProfileData>;

/**
 * Onboarding profile extractor (parity with Go profile_extractor.go): pulls structured
 * profile facts from the conversation and applies them to the user (filling only empty
 * fields). No automatic background fact extraction — onboarding + `remember` only.
 */
export class ProfileExtractor {
  constructor(
    private readonly factory: ModelFactory,
    private readonly settings: SettingsService,
    private readonly extractFn?: ExtractFn,
  ) {}

  async extract(messages: Message[]): Promise<ProfileData> {
    const roles = await this.settings.getModelRoles();
    const ref = roles.router || roles.default;
    if (this.extractFn) return this.extractFn(ref, messages);
    const convo = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const { object } = await generateObject({
      model: this.factory.model(ref),
      schema: ProfileSchema,
      system: SYSTEM_PROMPT,
      prompt: convo,
    });
    return object;
  }

  /** Extract, apply to the user (empty fields only), mark onboarded, upsert bot identity. */
  async applyOnboarding(db: Db, userId: number, messages: Message[]): Promise<ProfileData> {
    const profile = await this.extract(messages);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u) {
      log.warn({ userId }, "applyOnboarding: user not found");
      return profile;
    }

    const merged = mergeProfileIntoUser(
      { name: u.name, displayName: u.displayName, city: u.city, timezone: u.timezone, language: u.language },
      profile,
    );
    await db.update(users).set({ ...merged, onboarded: true, updatedAt: new Date() }).where(eq(users.id, userId));

    if (profile.bot_name || profile.vibe) {
      const botName = sanitizeProfileField(profile.bot_name);
      const vibe = sanitizeProfileField(profile.vibe);
      await db
        .insert(botIdentities)
        .values({ userId, botName, vibe })
        .onConflictDoUpdate({
          target: botIdentities.userId,
          set: { botName, vibe, updatedAt: new Date() },
        });
    }

    log.info({ userId, msgCount: messages.length }, "onboarding applied (user onboarded)");
    return profile;
  }
}

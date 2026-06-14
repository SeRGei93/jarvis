import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { users, botIdentities } from "../../db/schema.js";
import {
  sanitizeProfileField,
  validateTimezone,
  MAX_PROFILE_FIELD_LEN,
} from "../../pkg/promptguard.js";
import { logger } from "../../pkg/logger.js";
import type { ToolContext } from "./registry.js";

const log = logger.child({ mod: "tool-profile" });

// Max length for a free-form vibe description (Go parity: TruncateForContext(vibe, 200)).
const MAX_VIBE_LEN = 200;

/** Build the per-user profile / bot-identity tools (update_city/update_bot_vibe/update_bot_name). */
export function buildProfileTools(ctx: ToolContext): ToolSet {
  const { db, userId } = ctx;

  return {
    update_city: tool({
      description:
        "Update the user's city in their profile. Also sets the timezone if provided. " +
        "Use this when the user says where they live or moved to.",
      inputSchema: z.object({
        city: z.string().describe("City name (e.g. 'Минск', 'Москва', 'Гомель')"),
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone based on city (e.g. 'Europe/Minsk'). Optional."),
      }),
      execute: async ({ city, timezone }) => {
        const cleanCity = sanitizeProfileField(city, MAX_PROFILE_FIELD_LEN);
        if (cleanCity === "") {
          log.warn("update_city rejected (empty city)");
          return { message: "Rejected: city is required." };
        }

        const set: { city: string; timezone?: string; updatedAt: Date } = {
          city: cleanCity,
          updatedAt: new Date(),
        };

        let tzApplied = false;
        let tzRejected = false;
        if (timezone !== undefined && timezone !== "") {
          if (validateTimezone(timezone)) {
            set.timezone = timezone;
            tzApplied = true;
          } else {
            tzRejected = true;
            log.warn("update_city: timezone rejected (invalid IANA value)");
          }
        }

        log.debug({ field: "city", tzApplied }, "update_city changing");
        await db.update(users).set(set).where(eq(users.id, userId));

        let message = `City updated to: ${cleanCity}`;
        if (tzApplied) {
          message += ` (timezone: ${set.timezone})`;
        } else if (tzRejected) {
          message += " (timezone ignored: not a valid IANA timezone)";
        }
        log.info("update_city ok");
        return { message };
      },
    }),

    update_bot_vibe: tool({
      description:
        "Update the bot's communication style. Use this to adapt how you communicate based " +
        "on user preferences. Example: 'краткий, дружелюбный, с юмором', 'formal and detailed'.",
      inputSchema: z.object({
        vibe: z
          .string()
          .describe("New communication style description (e.g. 'краткий, дружелюбный, с юмором')"),
      }),
      execute: async ({ vibe }) => {
        const cleanVibe = sanitizeProfileField(vibe, MAX_VIBE_LEN);
        if (cleanVibe === "") {
          log.warn("update_bot_vibe rejected (empty vibe)");
          return { message: "Rejected: vibe is required." };
        }

        log.debug({ field: "vibe" }, "update_bot_vibe changing");
        await db
          .insert(botIdentities)
          .values({ userId, vibe: cleanVibe })
          .onConflictDoUpdate({
            target: botIdentities.userId,
            set: { vibe: cleanVibe, updatedAt: new Date() },
          });

        log.info("update_bot_vibe ok");
        return { message: `Communication style updated to: ${cleanVibe}` };
      },
    }),

    update_bot_name: tool({
      description:
        "Update the bot's name. Use this when the user asks to change or set the bot's name. " +
        "Example: 'Называй себя Ava', 'Твоё имя теперь Жарвис'.",
      inputSchema: z.object({
        bot_name: z.string().describe("New name for the bot (e.g. 'Жарвис', 'Ava', 'Помощник')"),
      }),
      execute: async ({ bot_name }) => {
        const cleanName = sanitizeProfileField(bot_name, MAX_PROFILE_FIELD_LEN);
        if (cleanName === "") {
          log.warn("update_bot_name rejected (empty name)");
          return { message: "Rejected: bot name is required." };
        }

        log.debug({ field: "botName" }, "update_bot_name changing");
        await db
          .insert(botIdentities)
          .values({ userId, botName: cleanName })
          .onConflictDoUpdate({
            target: botIdentities.userId,
            set: { botName: cleanName, updatedAt: new Date() },
          });

        log.info("update_bot_name ok");
        return { message: `Bot name updated to: ${cleanName}` };
      },
    }),
  };
}

/** Tool names provided by this bucket (user profile + bot identity edits). */
export const PROFILE_TOOL_NAMES = new Set(["update_city", "update_bot_vibe", "update_bot_name"]);

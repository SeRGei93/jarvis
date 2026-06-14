import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import {
  ProfileExtractor,
  mergeProfileIntoUser,
  type ProfileData,
  type ExtractFn,
} from "../../src/mastra/memory/profile-extractor.js";
import { shouldAutoCompleteOnboarding } from "../../src/domain/entities.js";
import { users, botIdentities } from "../../src/db/schema.js";
import type { ModelFactory } from "../../src/mastra/models.js";
import type { SettingsService } from "../../src/config/settings.js";

const fakeSettings = {
  getModelRoles: async () => ({
    default: "",
    router: "openrouter:r",
    embedding: "",
    error_correction: "",
    speech: "",
    synthesizer: "",
  }),
} as unknown as SettingsService;
const fakeFactory = {} as ModelFactory;

const empty = { name: "", displayName: "", city: "", timezone: "", language: "" };
const full: ProfileData = {
  name: "Серёжа",
  city: "Минск",
  timezone: "Europe/Minsk",
  language: "ru",
  bot_name: "Жак",
  vibe: "кратко",
};

describe("mergeProfileIntoUser", () => {
  it("fills empty fields and sets displayName", () => {
    const out = mergeProfileIntoUser(empty, full);
    expect(out).toMatchObject({
      name: "Серёжа",
      displayName: "Серёжа",
      city: "Минск",
      timezone: "Europe/Minsk",
      language: "ru",
    });
  });

  it("does NOT overwrite already-set fields", () => {
    const out = mergeProfileIntoUser({ ...empty, name: "Existing", city: "Brest" }, full);
    expect(out.name).toBe("Existing");
    expect(out.city).toBe("Brest");
  });

  it("ignores invalid timezone / language", () => {
    const out = mergeProfileIntoUser(empty, { ...full, timezone: "Not/AZone", language: "xx" });
    expect(out.timezone).toBe("");
    expect(out.language).toBe("");
  });
});

describe("shouldAutoCompleteOnboarding", () => {
  it("triggers at >= 4 messages when not onboarded", () => {
    expect(shouldAutoCompleteOnboarding(false, 3)).toBe(false);
    expect(shouldAutoCompleteOnboarding(false, 4)).toBe(true);
    expect(shouldAutoCompleteOnboarding(true, 4)).toBe(false);
  });
});

describe("ProfileExtractor.applyOnboarding", () => {
  let t: TestDb | undefined;
  afterEach(() => {
    t?.cleanup();
    t = undefined;
  });

  it("applies profile, sets onboarded, upserts bot identity", async () => {
    t = await createTestDb();
    await t.db.insert(users).values({ id: 1 });
    const extractFn: ExtractFn = async () => full;
    const px = new ProfileExtractor(fakeFactory, fakeSettings, extractFn);
    await px.applyOnboarding(t.db, 1, [{ role: "user", content: "привет, я Серёжа из Минска" }]);

    const [u] = await t.db.select().from(users).where(eq(users.id, 1));
    expect(u?.name).toBe("Серёжа");
    expect(u?.city).toBe("Минск");
    expect(u?.onboarded).toBe(true);

    const [bi] = await t.db.select().from(botIdentities).where(eq(botIdentities.userId, 1));
    expect(bi?.botName).toBe("Жак");
    expect(bi?.vibe).toBe("кратко");
  });

  it("does not overwrite already-set user fields", async () => {
    t = await createTestDb();
    await t.db.insert(users).values({ id: 1, name: "Существующее", city: "Брест" });
    const px = new ProfileExtractor(fakeFactory, fakeSettings, async () => full);
    await px.applyOnboarding(t.db, 1, []);
    const [u] = await t.db.select().from(users).where(eq(users.id, 1));
    expect(u?.name).toBe("Существующее");
    expect(u?.city).toBe("Брест");
    expect(u?.onboarded).toBe(true);
  });
});

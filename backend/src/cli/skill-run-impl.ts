import { db } from "../db/client.js";
import { storage } from "../mastra/index.js";
import { reconcileDefaults } from "../content/store.js";
import {
  skillsStoreDir,
  promptsStoreDir,
  DEFAULTS_SKILLS_DIR,
  DEFAULTS_PROMPTS_DIR,
} from "../content/paths.js";
import { createChatService } from "../app.js";
import { runSkillTest } from "../admin/api/skills.js";

/**
 * CLI analog of the Mini App skill test-run. Runs ONE non-streaming generation of
 * a skill against a message (same `runSkillTest` the admin endpoint uses) and
 * prints the model's raw markdown answer.
 *
 * Unlike the Telegram path there is no rich send, so media markdown (`![](url)`,
 * `Фото:` lines) and reasoning are visible verbatim — handy for debugging skills
 * and verifying tool output (e.g. that av.by now returns real photo URLs).
 *
 * Needs the same environment as the bot: a migrated DB (LIBSQL_URL) with settings
 * and a provider key (OPENROUTER_API_KEY). Run it where the bot runs, or point
 * LIBSQL_URL at a seeded local DB.
 */
export async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv[0];
  const message = argv.slice(1).join(" ").trim();
  if (!name || !message) {
    process.stderr.write(
      'Usage: npm run skill:run -- <skill> "<message>"\n' +
        'Example: npm run skill:run -- cars "найди на av.by Audi A4 B9 2019 дизель, покажи фото"\n',
    );
    process.exit(2);
  }

  // Populate the file-backed skill/prompt store from bundled defaults (boot parity).
  await Promise.all([
    reconcileDefaults(skillsStoreDir(), DEFAULTS_SKILLS_DIR),
    reconcileDefaults(promptsStoreDir(), DEFAULTS_PROMPTS_DIR),
  ]);

  const svc = await createChatService({ db, storage });
  try {
    const skill = await svc.deps.skills.skillRepo.getByName(name);
    if (!skill) {
      const available = (await svc.deps.skills.skillRepo.list()).map((s) => s.name).join(", ");
      process.stderr.write(`Skill "${name}" not found. Available: ${available}\n`);
      process.exitCode = 1;
      return;
    }

    process.stderr.write(`\n▶ skill "${name}" — running…\n\n`);
    const res = await runSkillTest(svc.deps, skill, message);
    process.stdout.write(res.text + "\n");
    process.stderr.write(`\n[cost: $${res.cost ?? 0}]\n`);
  } finally {
    await svc.close();
  }
}

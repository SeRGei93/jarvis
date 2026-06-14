import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Keep logger quiet during tests (pino accepts the "silent" level).
    env: { LOG_LEVEL: "silent" },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

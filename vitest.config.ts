import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    globalSetup: ["tests/setup/global.ts"],
    setupFiles: ["tests/setup/env.ts"],
    pool: "forks",
    fileParallelism: false, // one shared Postgres/Redis; files run sequentially
    testTimeout: 120_000,
    hookTimeout: 180_000,
    include: ["tests/**/*.test.ts"],
  },
});

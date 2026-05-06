import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    include: ["test/**/*.test.ts"],
    // run tests sequentially — each spins up a real server on a random port,
    // so no port conflicts, but SQLite + fs are cheap enough to keep serial
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});

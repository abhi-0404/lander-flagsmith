import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // some tests create throwaway git repos, which is slow on Windows
    testTimeout: 30_000,
  },
});

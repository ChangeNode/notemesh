import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Server-side modules only — these exercise real git and the filesystem,
    // so they run in node rather than a browser-like environment.
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});

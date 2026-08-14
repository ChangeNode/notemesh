import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Server-side modules only — these exercise real git and the filesystem,
    // so they run in node rather than a browser-like environment.
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
  resolve: {
    // tsconfig declares "~/*" -> "./src/*", but that is TypeScript's resolution
    // only — Vitest knew nothing about it, so an import through the alias
    // typechecked and then failed at runtime with "Cannot find module". It went
    // unnoticed because every test lived inside src/ and used relative paths.
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});

import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./e2e/server";

export default defineConfig({
  testDir: "./e2e",
  // Spec files, so vitest's src/**/*.test.ts glob never picks these up — two
  // runners collecting each other's tests is a confusing failure.
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // One worker: every test drives the same seeded server, and the admin panel
  // is single-user by design, so parallel sessions would fight over state.
  workers: 1,
  fullyParallel: false,
  // A failing browser test is usually a real failure rather than a flake, and a
  // retry would hide the difference.
  retries: 0,
  reporter: process.env.CI ? "list" : "line",
  use: {
    baseURL: BASE_URL,
    // Kept for the first failure only: enough to diagnose, not enough to fill
    // the runner with artefacts.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated like supervisor-reauth.test.ts: this file mocks ./cli and
// ./settings-sync, and the tally tests next door run against the real ones.

const enableSettingsSync = vi.fn<() => Promise<{ ok: boolean; message: string }>>();
vi.mock("./settings-sync", () => ({ enableSettingsSync: () => enableSettingsSync() }));
vi.mock("./cli", () => ({
  obIsAuthenticated: () => Promise.resolve(true),
  obSyncConfigured: () => Promise.resolve(true),
  obSyncOnce: () => Promise.resolve({ ok: true, output: "" }),
}));

const { SyncSupervisor } = await import("./supervisor");

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-sup-settings-")));
  fs.mkdirSync(path.join(root, "vault"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  process.env.DATA_DIR = root;
  // A daemon stand-in that stays up until killed.
  const script = path.join(root, "fake-ob");
  fs.writeFileSync(script, "#!/bin/sh\nexec sleep 30\n");
  fs.chmodSync(script, 0o755);
  process.env.OB_BIN = script;
  enableSettingsSync.mockReset();
  enableSettingsSync.mockResolvedValue({ ok: true, message: "" });
});

afterEach(() => {
  delete process.env.OB_BIN;
  delete process.env.DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the supervisor turns settings sync on", () => {
  it("once per process, on the first start and not on a restart", async () => {
    const sup = new SyncSupervisor();
    sup.start();
    await vi.waitFor(() => expect(enableSettingsSync).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    sup.stop();
    await vi.waitFor(() => expect(sup.status().state).toBe("stopped"), { timeout: 5_000 });
    sup.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(enableSettingsSync).toHaveBeenCalledTimes(1);
    sup.stop();
    await vi.waitFor(() => expect(sup.status().state).toBe("stopped"), { timeout: 5_000 });
  });

  it("starts the daemon whether or not the call succeeds", async () => {
    enableSettingsSync.mockRejectedValue(new Error("no daemon"));
    const sup = new SyncSupervisor();
    sup.start();
    await vi.waitFor(() => expect(enableSettingsSync).toHaveBeenCalled());
    expect(sup.status().state).toBe("running");
    sup.stop();
    await vi.waitFor(() => expect(sup.status().state).toBe("stopped"), { timeout: 5_000 });
  });
});

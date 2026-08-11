import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolated from supervisor.test.ts because this file mocks ./cli, and the
// activity-tally tests next door should keep running against the real module.

const obIsAuthenticated = vi.fn<() => Promise<boolean>>();
vi.mock("./cli", () => ({
  obIsAuthenticated: () => obIsAuthenticated(),
  obSyncConfigured: () => Promise.resolve(true),
  obSyncOnce: () => Promise.resolve({ ok: true, output: "" }),
}));

const { SyncSupervisor } = await import("./supervisor");

/**
 * The reported failure, reproduced at the seam where it went wrong.
 *
 * The operator revoked their Obsidian credentials. The daemon did not exit — it
 * reconnected every 30 seconds, failing to authenticate each time — so the
 * re-auth check hanging off child exit never ran, and the Status tab kept
 * reporting a healthy sync. These drive the same path with a stub child, since
 * the point is the wiring rather than anything about process spawning.
 */
function running() {
  const sup = new SyncSupervisor() as unknown as {
    state: string;
    child: { kill: ReturnType<typeof vi.fn> } | null;
    log: (line: string) => void;
    getLogs: () => { line: string }[];
    authProbing: boolean;
    authProbeAt: number;
  };
  sup.state = "running";
  sup.child = { kill: vi.fn() };
  return sup;
}

const AUTH_FAILURE = "Error: Failed to authenticate: Not logged in";

/**
 * Wait for the probe to finish, not merely to start.
 *
 * Waiting on "was called" is what a first pass at these tests did, and it let
 * two mutations through: the assertion ran while the probe was still suspended
 * at its await, so "kill was not called" was true simply because nothing had
 * got that far yet. `authProbing` drops only in the finally block.
 */
async function settled(sup: { authProbing: boolean }) {
  await vi.waitFor(() => expect(obIsAuthenticated).toHaveBeenCalled());
  await vi.waitFor(() => expect(sup.authProbing).toBe(false));
}

beforeEach(() => {
  obIsAuthenticated.mockReset();
});

describe("a daemon that cannot authenticate but will not exit", () => {
  it("is stopped once the out-of-band check confirms it", async () => {
    obIsAuthenticated.mockResolvedValue(false);
    const sup = running();

    sup.log(AUTH_FAILURE);

    await vi.waitFor(() => expect(sup.child!.kill).toHaveBeenCalledWith("SIGTERM"));
    // Killing it hands over to the exit path, which is the one place that
    // latches needs-reauth. Nothing here sets the state itself.
    expect(sup.state).toBe("running");
    expect(sup.getLogs().some((l) => /cannot authenticate/.test(l.line))).toBe(true);
  });

  it("says why in the log the operator is already watching", async () => {
    obIsAuthenticated.mockResolvedValue(false);
    const sup = running();

    sup.log(AUTH_FAILURE);

    await vi.waitFor(() => expect(sup.child!.kill).toHaveBeenCalled());
    const said = sup.getLogs().map((l) => l.line).join("\n");
    expect(said).toMatch(/re-authenticate/i);
  });
});

describe("what it does not do", () => {
  it("leaves a healthy daemon alone when the check disagrees", async () => {
    // The line can come from a note called "Not logged in.md". The text is only
    // ever a trigger; this is the check refusing to act on it.
    obIsAuthenticated.mockResolvedValue(true);
    const sup = running();

    sup.log("Downloaded Notes/Not logged in.md");

    await settled(sup);
    expect(sup.child!.kill).not.toHaveBeenCalled();
  });

  it("treats an unreachable Obsidian as authenticated rather than locked out", async () => {
    obIsAuthenticated.mockRejectedValue(new Error("network down"));
    const sup = running();

    sup.log(AUTH_FAILURE);

    await settled(sup);
    expect(sup.child!.kill).not.toHaveBeenCalled();
  });

  it("probes at most once per interval, not once per failed reconnect", async () => {
    obIsAuthenticated.mockResolvedValue(true);
    const sup = running();

    sup.log(AUTH_FAILURE);
    await settled(sup);
    expect(obIsAuthenticated).toHaveBeenCalledTimes(1);

    // A second failure, after the first probe has fully finished, so the
    // in-flight guard cannot be what suppresses it — only the interval can.
    sup.log(AUTH_FAILURE);
    await new Promise((r) => setTimeout(r, 20));
    expect(obIsAuthenticated).toHaveBeenCalledTimes(1);

    // Wind the clock past the interval and it is willing again.
    sup.authProbeAt = Date.now() - 61_000;
    sup.log(AUTH_FAILURE);
    await vi.waitFor(() => expect(obIsAuthenticated).toHaveBeenCalledTimes(2));
  });

  it("does not probe when the daemon is not running", async () => {
    obIsAuthenticated.mockResolvedValue(false);
    const sup = running();
    sup.state = "needs-reauth";

    sup.log(AUTH_FAILURE);

    await new Promise((r) => setTimeout(r, 10));
    expect(obIsAuthenticated).not.toHaveBeenCalled();
  });
});

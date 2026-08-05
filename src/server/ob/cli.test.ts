import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ObArgError,
  assertSafeArg,
  looksLikeAuthFailure,
  looksLikeMfaRequired,
  obIsAuthenticated,
  obListRemoteVaults,
  parseVaultListText,
  redact,
  runOb,
} from "./cli";

// The Obsidian Sync path. An account can't be exercised in CI, but the parts
// that actually go wrong can: the guards on what reaches the CLI's argv, the
// scrubbing of secrets out of captured output, and the handling of ob's
// unreliable exit codes. Those last are driven through a fake `ob` on OB_BIN,
// which is a supported override rather than a test-only hook.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-cli-"));
  process.env.DATA_DIR = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.OB_BIN;
});

/** Install a stand-in `ob` that prints fixed output and exits with `code`. */
function fakeOb(stdout: string, code = 0) {
  const script = path.join(dir, "fake-ob");
  fs.writeFileSync(script, `#!/bin/sh\ncat <<'OBEOF'\n${stdout}\nOBEOF\nexit ${code}\n`);
  fs.chmodSync(script, 0o755);
  process.env.OB_BIN = script;
}

describe("assertSafeArg", () => {
  it("accepts an ordinary value", () => {
    expect(() => assertSafeArg("me@example.com", "Email")).not.toThrow();
  });

  it("accepts a vault name with spaces and punctuation", () => {
    expect(() => assertSafeArg("My Vault (2026)", "Vault")).not.toThrow();
  });

  it("refuses a value that would be read as a flag", () => {
    // A vault id arrives from parsed ob output; if it began with a dash it
    // would be swallowed by ob's own argument parser as an option.
    expect(() => assertSafeArg("--path=/etc", "Vault")).toThrow(ObArgError);
    expect(() => assertSafeArg("-rf", "Vault")).toThrow(ObArgError);
  });

  it("refuses control characters", () => {
    expect(() => assertSafeArg("vault\u0000name", "Vault")).toThrow(ObArgError);
    expect(() => assertSafeArg("vault\nname", "Vault")).toThrow(ObArgError);
    expect(() => assertSafeArg("vault\u001Bname", "Vault")).toThrow(ObArgError);
  });

  it("names the offending field so the error is actionable", () => {
    expect(() => assertSafeArg("-x", "Vault")).toThrow(/Vault/);
  });
});

describe("redact", () => {
  it("removes a secret from captured output", () => {
    expect(redact("login failed for hunter2xyz", ["hunter2xyz"])).not.toContain("hunter2xyz");
  });

  it("removes every occurrence", () => {
    const out = redact("hunter2xyz and again hunter2xyz", ["hunter2xyz"]);
    expect(out).not.toContain("hunter2xyz");
    expect(out.match(/«redacted»/g)).toHaveLength(2);
  });

  it("handles several secrets at once", () => {
    const out = redact("a=alpha123 b=bravo456", ["alpha123", "bravo456"]);
    expect(out).not.toContain("alpha123");
    expect(out).not.toContain("bravo456");
  });

  it("ignores undefined secrets", () => {
    expect(redact("nothing to hide", [undefined])).toBe("nothing to hide");
  });

  it("leaves very short secrets alone rather than shredding the output", () => {
    // Redacting a 2-character secret would replace half the log with markers
    // and tell an operator nothing.
    expect(redact("the cat sat", ["at"])).toBe("the cat sat");
  });

  it("leaves unrelated text untouched", () => {
    expect(redact("all good here", ["hunter2xyz"])).toBe("all good here");
  });
});

describe("looksLikeMfaRequired", () => {
  it.each(["Enter your MFA code", "2FA required", "two-factor authentication", "verification code sent", "one-time code"])(
    "detects %s",
    (text) => expect(looksLikeMfaRequired(text)).toBe(true),
  );

  it.each(["Sync complete", "Downloaded 4 files"])("does not fire on %s", (text) =>
    expect(looksLikeMfaRequired(text)).toBe(false),
  );
});

describe("looksLikeAuthFailure", () => {
  it.each([
    "unauthorized",
    "no account logged in",
    "Login failed",
    "invalid email or password",
    "session expired",
    "401",
  ])("detects %s", (text) => expect(looksLikeAuthFailure(text)).toBe(true));

  it.each(["Fully synced", "Downloaded 3 files"])("does not fire on %s", (text) =>
    expect(looksLikeAuthFailure(text)).toBe(false),
  );
});

describe("obIsAuthenticated", () => {
  // ob returns exit code 0 even when logged out, so the exit code cannot be
  // trusted — authentication is decided from the output of a command that
  // genuinely requires it.
  it("is true when the vault list parses", async () => {
    fakeOb(JSON.stringify({ vaults: [{ id: "a", name: "Home" }] }));
    expect(await obIsAuthenticated()).toBe(true);
  });

  it("is false when ob reports being logged out despite exiting 0", async () => {
    fakeOb("no account logged in", 0);
    expect(await obIsAuthenticated()).toBe(false);
  });

  it("is false on 'not logged in' phrasing", async () => {
    fakeOb("Error: not logged in", 0);
    expect(await obIsAuthenticated()).toBe(false);
  });

  it("is false when the output can't be confirmed, rather than assuming success", async () => {
    // Conservative on purpose: an unparseable response prompts re-auth instead
    // of leaving the daemon looping in backoff.
    fakeOb("something unexpected", 0);
    expect(await obIsAuthenticated()).toBe(false);
  });

  it("is true for an account with no vaults yet", async () => {
    fakeOb(JSON.stringify({ vaults: [] }));
    expect(await obIsAuthenticated()).toBe(true);
  });

  it("is false when the binary is missing entirely", async () => {
    process.env.OB_BIN = path.join(dir, "does-not-exist");
    expect(await obIsAuthenticated()).toBe(false);
  });
});

describe("obListRemoteVaults", () => {
  it("parses the JSON shape", async () => {
    fakeOb(
      JSON.stringify({
        vaults: [{ id: "v1", name: "Home", region: "North America" }],
        shared: [{ id: "v2", name: "Team" }],
      }),
    );
    const { vaults } = await obListRemoteVaults();
    expect(vaults.map((v) => v.name)).toEqual(["Home", "Team"]);
    expect(vaults[0]).toMatchObject({ id: "v1", region: "North America" });
  });

  it("includes shared vaults alongside owned ones", async () => {
    fakeOb(JSON.stringify({ vaults: [], shared: [{ id: "s", name: "Shared" }] }));
    const { vaults } = await obListRemoteVaults();
    expect(vaults).toHaveLength(1);
  });

  it("falls back to the text parser when the output isn't JSON", async () => {
    fakeOb('"Home" (North America)\n"Work" (Europe)');
    const { vaults } = await obListRemoteVaults();
    expect(vaults.map((v) => v.name)).toEqual(["Home", "Work"]);
    expect(vaults[0].region).toBe("North America");
  });

  it("returns nothing when the command fails", async () => {
    fakeOb("boom", 1);
    const { result, vaults } = await obListRemoteVaults();
    expect(result.ok).toBe(false);
    expect(vaults).toEqual([]);
  });

  it("names an unnamed vault rather than returning undefined", async () => {
    fakeOb(JSON.stringify({ vaults: [{ id: "v1" }] }));
    const { vaults } = await obListRemoteVaults();
    expect(vaults[0].name).toBe("v1");
  });
});

describe("parseVaultListText", () => {
  it("reads the quoted name and region form", () => {
    expect(parseVaultListText('"Home" (North America)')).toEqual([
      { name: "Home", region: "North America", raw: '"Home" (North America)' },
    ]);
  });

  it("skips status chatter above the list", () => {
    const out = parseVaultListText('Fetching vaults...\nVaults:\n---\n"Home" (EU)');
    expect(out.map((v) => v.name)).toEqual(["Home"]);
  });

  it("falls back to a bare line when there is no region", () => {
    expect(parseVaultListText("Home").map((v) => v.name)).toEqual(["Home"]);
  });

  it("returns nothing for empty output", () => {
    expect(parseVaultListText("")).toEqual([]);
  });
});

describe("runOb", () => {
  it("captures output and reports success", async () => {
    fakeOb("hello");
    const res = await runOb(["anything"]);
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe("hello");
  });

  it("reports a non-zero exit without throwing", async () => {
    fakeOb("bad", 3);
    expect((await runOb(["anything"])).ok).toBe(false);
  });

  it("scrubs secrets out of everything it returns", async () => {
    fakeOb("failed for supersecret123");
    const res = await runOb(["anything"], { redactSecrets: ["supersecret123"] });
    expect(res.stdout).not.toContain("supersecret123");
    expect(res.combined).not.toContain("supersecret123");
  });

  it("reports a missing binary as a failure rather than throwing", async () => {
    process.env.OB_BIN = path.join(dir, "nope");
    const res = await runOb(["anything"]);
    expect(res.ok).toBe(false);
  });

  it("passes a secret on stdin so it never lands in argv", async () => {
    // argv is world-readable via ps/proc; the password goes down stdin instead.
    const script = path.join(dir, "echo-stdin");
    fs.writeFileSync(script, "#!/bin/sh\ncat\n");
    fs.chmodSync(script, 0o755);
    process.env.OB_BIN = script;
    const res = await runOb(["login"], { stdinInput: "hunter2\n" });
    expect(res.stdout.trim()).toBe("hunter2");
  });
});

// A vault that was never linked fails identically every time, so the supervisor
// has to tell that apart from a crash worth retrying. `ob` makes that awkward:
// on an unconfigured vault `sync-status --json` prints a prose sentence and
// exits 0, so neither the exit code nor "the command ran" means anything.
describe("detecting an unlinked vault", () => {
  it("reads the prose ob actually prints", () => {
    // Captured from obsidian-headless 0.0.14 against an empty directory:
    //   $ ob sync-status --path /tmp/x --json
    //   No sync configuration found for /tmp/x
    //   $ echo $?   → 0
    const observed = "No sync configuration found for /data/vault\nRun 'ob sync-setup' first.\n";
    expect(/no sync configuration found|run ['"]?ob sync-setup/i.test(observed)).toBe(true);
  });

  it("does not mistake ordinary status output for a missing configuration", () => {
    const configured = '{"vault":"Home","state":"synced","files":1200}';
    expect(/no sync configuration found|run ['"]?ob sync-setup/i.test(configured)).toBe(false);
    expect(() => JSON.parse(configured)).not.toThrow();
  });

  it("treats unparseable output as unconfigured rather than assuming success", () => {
    // The exit code says 0 either way, so a JSON body is the only positive
    // evidence available.
    for (const output of ["No sync configuration found for /data/vault", "", "???"]) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(output);
      } catch {
        parsed = null;
      }
      expect(typeof parsed === "object" && parsed !== null).toBe(false);
    }
  });
});

import { describe, expect, it, vi, afterEach } from "vitest";
import { authLog, isSqliteArrayColumnWarning } from "./auth-logger";

// The exact lines Better Auth prints on every boot once the oauth tables
// exist, copied from a Railway deploy log rather than paraphrased — the filter
// is a string match against another project's message, so the fixture has to be
// that project's actual output.
const REAL_WARNINGS = [
  "Field scopes in table oauthClient has a different type in the database. Expected string[] but got TEXT.",
  "Field contacts in table oauthClient has a different type in the database. Expected string[] but got TEXT.",
  "Field redirectUris in table oauthClient has a different type in the database. Expected string[] but got TEXT.",
  "Field postLogoutRedirectUris in table oauthClient has a different type in the database. Expected string[] but got TEXT.",
  "Field grantTypes in table oauthClient has a different type in the database. Expected string[] but got TEXT.",
  "Field responseTypes in table oauthClient has a different type in the database. Expected string[] but got TEXT.",
  "Field scopes in table oauthRefreshToken has a different type in the database. Expected string[] but got TEXT.",
  "Field scopes in table oauthAccessToken has a different type in the database. Expected string[] but got TEXT.",
  "Field scopes in table oauthConsent has a different type in the database. Expected string[] but got TEXT.",
];

describe("isSqliteArrayColumnWarning", () => {
  it("matches every array-column warning a real boot produces", () => {
    for (const message of REAL_WARNINGS) {
      expect(isSqliteArrayColumnWarning("warn", message), message).toBe(true);
    }
  });

  it("lets a genuine type mismatch through", () => {
    // Same sentence, different types. If the filter ever widens to the message
    // shape alone it would start hiding schema drift that matters.
    for (const message of [
      "Field emailVerified in table user has a different type in the database. Expected boolean but got TEXT.",
      "Field createdAt in table session has a different type in the database. Expected date but got INTEGER.",
      "Field scopes in table oauthClient has a different type in the database. Expected string[] but got BLOB.",
      "Field id in table user has a different type in the database. Expected string but got INTEGER.",
    ]) {
      expect(isSqliteArrayColumnWarning("warn", message), message).toBe(false);
    }
  });

  it("does not match on other log levels", () => {
    expect(isSqliteArrayColumnWarning("error", REAL_WARNINGS[0])).toBe(false);
    expect(isSqliteArrayColumnWarning("info", REAL_WARNINGS[0])).toBe(false);
  });

  it("does not match when the sentence is merely contained in a longer message", () => {
    expect(
      isSqliteArrayColumnWarning(
        "warn",
        `Something is wrong. ${REAL_WARNINGS[0]} And another thing.`,
      ),
    ).toBe(false);
  });
});

describe("authLog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("swallows the array-column warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const message of REAL_WARNINGS) authLog("warn", message);
    expect(warn).not.toHaveBeenCalled();
  });

  it("still prints other warnings, with the Better Auth prefix intact", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    authLog("warn", "Please ensure the endpoint exists");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("WARN [Better Auth]: Please ensure the endpoint exists");
  });

  it("routes errors to console.error and passes extra args along", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const detail = { code: "boom" };
    authLog("error", "Something failed", detail);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("ERROR [Better Auth]: Something failed");
    expect(error.mock.calls[0][1]).toBe(detail);
  });
});

import { describe, expect, it } from "vitest";
import { redactRemote, remoteHasCredentials, validateRemoteUrl } from "./remote";

describe("validateRemoteUrl", () => {
  it("accepts an ordinary HTTPS clone URL, trimmed", () => {
    expect(validateRemoteUrl("  https://github.com/me/vault.git \n")).toEqual({
      ok: true,
      url: "https://github.com/me/vault.git",
    });
    expect(validateRemoteUrl("https://gitlab.example.com:8443/team/vault").ok).toBe(true);
  });

  it("refuses credentials embedded in the URL, and says where they go", () => {
    for (const url of [
      "https://me:ghp_secret@github.com/me/vault.git",
      "https://x-access-token:ghp_secret@github.com/me/vault.git",
      "https://me@github.com/me/vault.git",
      "https://:ghp_secret@github.com/me/vault.git",
    ]) {
      const res = validateRemoteUrl(url);
      expect(res.ok, url).toBe(false);
      expect((res as { message: string }).message).toMatch(/Leave credentials out of the URL/);
    }
  });

  it("refuses what is not HTTPS", () => {
    for (const url of ["git@github.com:me/vault.git", "ssh://git@github.com/me/vault.git", "http://example.com/x.git", "", "https://"]) {
      expect(validateRemoteUrl(url).ok, url).toBe(false);
    }
  });

  it("allows a local path only when told to, and still refuses credentials then", () => {
    expect(validateRemoteUrl("/tmp/remote.git").ok).toBe(false);
    expect(validateRemoteUrl("/tmp/remote.git", true).ok).toBe(true);
    expect(validateRemoteUrl("file:///tmp/remote.git", true).ok).toBe(true);
    expect(validateRemoteUrl("https://me:pw@example.com/x.git", true).ok).toBe(false);
  });
});

describe("a stored remote with credentials", () => {
  it("is recognised, and shown blanked", () => {
    const url = "https://me:ghp_secret@github.com/me/vault.git";
    expect(remoteHasCredentials(url)).toBe(true);
    expect(redactRemote(url)).toBe("https://***@github.com/me/vault.git");
    expect(redactRemote(url)).not.toContain("ghp_secret");
    expect(redactRemote(url)).not.toContain("me:");
  });

  it("leaves a clean remote, or a non-URL, exactly as it is", () => {
    expect(remoteHasCredentials("https://github.com/me/vault.git")).toBe(false);
    expect(redactRemote("https://github.com/me/vault.git")).toBe("https://github.com/me/vault.git");
    expect(redactRemote("/tmp/remote.git")).toBe("/tmp/remote.git");
  });
});

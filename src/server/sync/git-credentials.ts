import { getSetting, setSetting, deleteSetting } from "../db";
import { encryptSecret, decryptSecret } from "../crypto";

// Git access credentials, AES-256-GCM encrypted in the settings table.
//
// Worth noting how much better this is than the Obsidian path: that one has to
// store the user's actual account password, because the sync client
// re-authenticates with it. A git token is scoped to one repository, carries no
// other authority, and the user can revoke it without touching anything else.

export function storeGitCredentials(username: string, token: string) {
  setSetting("git_username", username.trim() || "x-access-token");
  setSetting("git_token", encryptSecret(token));
}

export function getGitCredentials(): { username: string; token: string } | null {
  const token = getSetting("git_token");
  if (!token) return null;
  return {
    // GitHub accepts any username when the password is a PAT; other hosts want
    // the real one, so it is stored rather than assumed.
    username: getSetting("git_username") || "x-access-token",
    token: decryptSecret(token),
  };
}

export function hasGitCredentials(): boolean {
  return Boolean(getSetting("git_token"));
}

export function clearGitCredentials() {
  deleteSetting("git_username");
  deleteSetting("git_token");
}

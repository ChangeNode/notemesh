import { getSetting, setSetting, deleteSetting } from "../db";
import { encryptSecret, decryptSecret } from "../crypto";

// Obsidian account + vault E2E credentials, AES-256-GCM encrypted in the
// settings table. Needed to re-login when the ob session expires.

export function storeObsidianAccount(email: string, password: string) {
  setSetting("obsidian_email", encryptSecret(email));
  setSetting("obsidian_password", encryptSecret(password));
}

/**
 * The stored Obsidian login, or why there isn't one.
 *
 * "Absent" and "unreadable" need telling apart. decryptSecret throws when the
 * ciphertext will not authenticate, which is what happens after ENCRYPTION_KEY
 * is rotated — the documented consequence of changing it. Letting that
 * exception escape turned re-authentication into a 500 with a decrypt error in
 * it; collapsing both cases into null told the operator "no stored
 * credentials" when the truth is that the credentials are there and the key
 * is not.
 */
export type StoredAccount =
  | { state: "ok"; email: string; password: string }
  | { state: "missing" }
  | { state: "unreadable" };

export function obsidianAccountState(): StoredAccount {
  const email = getSetting("obsidian_email");
  const password = getSetting("obsidian_password");
  if (!email || !password) return { state: "missing" };
  try {
    return { state: "ok", email: decryptSecret(email), password: decryptSecret(password) };
  } catch {
    // Almost always a changed ENCRYPTION_KEY. The stored bytes are intact and
    // useless; the only way forward is entering the credentials again.
    return { state: "unreadable" };
  }
}

export function getObsidianAccount(): { email: string; password: string } | null {
  const account = obsidianAccountState();
  return account.state === "ok" ? { email: account.email, password: account.password } : null;
}

export function storeVaultPassword(password: string) {
  setSetting("vault_password", encryptSecret(password));
}

export function getVaultPassword(): string | null {
  const v = getSetting("vault_password");
  return v ? decryptSecret(v) : null;
}

export function clearObsidianCredentials() {
  deleteSetting("obsidian_email");
  deleteSetting("obsidian_password");
  deleteSetting("vault_password");
}

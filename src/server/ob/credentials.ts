import { getSetting, setSetting, deleteSetting } from "../db";
import { encryptSecret, decryptSecret } from "../crypto";

// Obsidian account + vault E2E credentials, AES-256-GCM encrypted in the
// settings table. Needed to re-login when the ob session expires.

export function storeObsidianAccount(email: string, password: string) {
  setSetting("obsidian_email", encryptSecret(email));
  setSetting("obsidian_password", encryptSecret(password));
}

export function getObsidianAccount(): { email: string; password: string } | null {
  const email = getSetting("obsidian_email");
  const password = getSetting("obsidian_password");
  if (!email || !password) return null;
  return { email: decryptSecret(email), password: decryptSecret(password) };
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

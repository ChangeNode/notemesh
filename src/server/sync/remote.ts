/**
 * The git remote URL, as the operator types it and as it is shown back.
 *
 * Credentials belong in their own fields, where they are stored encrypted and
 * handed to git through a credential helper for the one command that needs
 * them. A URL of the form https://user:token@host/repo.git would instead put
 * the token in plaintext settings, in .git/config, in the log line that names
 * the remote, and on the Status tab (NM-SEC-011, #59). So it is refused at
 * setup, and a URL stored that way under an earlier version is shown with the
 * credentials blanked and called out on start.
 */

export type RemoteCheck = { ok: true; url: string } | { ok: false; message: string };

export function validateRemoteUrl(remote: string, allowLocal = false): RemoteCheck {
  const url = remote.trim();
  // HTTPS only: the token travels with every fetch and push, so a plaintext
  // remote would put it on the wire. Local paths are for the project's own
  // tests, and only when explicitly allowed.
  const acceptable = allowLocal
    ? /^(https:\/\/|file:\/\/|\/)[^\s]+$/i.test(url)
    : /^https:\/\/[^\s]+$/i.test(url);
  if (!acceptable) {
    return { ok: false, message: "Use an HTTPS clone URL (https://…). SSH remotes aren't supported yet." };
  }
  if (remoteHasCredentials(url)) {
    return {
      ok: false,
      message:
        "Leave credentials out of the URL. Put the username and token in their own fields: " +
        "they are stored encrypted there, and never written into the repository's config or the log.",
    };
  }
  return { ok: true, url };
}

/** True when the URL carries a username or password in front of the host. */
export function remoteHasCredentials(remote: string): boolean {
  try {
    const u = new URL(remote);
    return u.username !== "" || u.password !== "";
  } catch {
    return false;
  }
}

/** The URL with any credentials blanked, for logs and the Status tab. */
export function redactRemote(remote: string): string {
  if (!remoteHasCredentials(remote)) return remote;
  const u = new URL(remote);
  u.username = "***";
  u.password = "";
  return u.toString();
}

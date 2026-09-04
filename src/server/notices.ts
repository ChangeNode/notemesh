/**
 * One-shot notices to connectors.
 *
 * An alert (mcp/alerts.ts) is a state: present on every response while a
 * condition holds, absent when it does not. A notice is an event the server
 * has already dealt with — a git conflict resolved by writing a conflicted
 * copy — and it is delivered on the next tool call from each connector, once,
 * then never again. Both ride the same content block after the payload.
 *
 * A connector is a credential label ("api-key:…", "oauth:<client>"), which is
 * what a tool call carries. A notice older than the TTL is dropped rather than
 * held for a connector that never comes back. The store lives on globalThis,
 * like the backends that post to it, so a module reload cannot lose a notice
 * that a backend instance from before the reload still holds a reference to.
 */

export const NOTICE_TTL_MS = 24 * 60 * 60_000;
const MAX_NOTICES = 20;

interface Notice {
  seq: number;
  at: number;
  text: string;
}

interface Store {
  seq: number;
  notices: Notice[];
  /** Per connector label, the last sequence number delivered to it. */
  seen: Map<string, number>;
}

const globalKey = "__notemeshNotices";
function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  if (!g[globalKey]) g[globalKey] = { seq: 0, notices: [], seen: new Map() };
  return g[globalKey]!;
}

/** Post a notice for every connector. `text` is the body; the prefix is added on delivery. */
export function postNotice(text: string, now = Date.now()): void {
  const s = store();
  s.notices.push({ seq: ++s.seq, at: now, text });
  if (s.notices.length > MAX_NOTICES) s.notices.splice(0, s.notices.length - MAX_NOTICES);
}

/**
 * The notices this connector has not yet been given, oldest first, at most
 * `limit` of them. Only what is returned is marked delivered, so a notice held
 * back by the limit arrives on the following call rather than being lost.
 */
export function takeNotices(label: string, limit = Infinity, now = Date.now()): string[] {
  const s = store();
  const seen = s.seen.get(label) ?? 0;
  const fresh = s.notices.filter((n) => n.seq > seen && now - n.at <= NOTICE_TTL_MS);
  const take = fresh.slice(0, limit);
  if (take.length) s.seen.set(label, take[take.length - 1].seq);
  else if (s.notices.length) s.seen.set(label, s.notices[s.notices.length - 1].seq);
  return take.map((n) => n.text);
}

/** Tests only: forget every notice and every delivery. */
export function clearNotices(): void {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  delete g[globalKey];
}

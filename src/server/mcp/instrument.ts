// Latency instrumentation for diagnosing stalls.
//
// Node is single-threaded, so a slow MCP response is usually *queue* time
// behind synchronous work elsewhere, not the handler itself. Measuring both
// separately is the only way to tell those apart.

let lagMonitorStarted = false;
let maxLagMs = 0;
let lastLagReport = 0;

// Samples how late a 500ms timer actually fires. A timer that fires 40s late
// means something held the event loop for ~40s.
export function startLoopLagMonitor() {
  if (lagMonitorStarted) return;
  lagMonitorStarted = true;
  const INTERVAL = 500;
  let expected = Date.now() + INTERVAL;
  setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + INTERVAL;
    if (lag > maxLagMs) maxLagMs = lag;
    if (lag > 1000 && now - lastLagReport > 2000) {
      lastLagReport = now;
      console.warn(`[lag] event loop blocked ~${lag}ms`);
    }
  }, INTERVAL).unref?.();
}

export function loopLagStats() {
  return { maxLagMs };
}

export function resetLoopLag() {
  maxLagMs = 0;
}

// Logs any MCP request slower than the threshold, separating the time spent
// inside the handler from total request time.
const SLOW_MS = 1000;

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const dt = Date.now() - t0;
    if (dt > SLOW_MS) console.warn(`[slow] ${label} took ${dt}ms`);
  }
}

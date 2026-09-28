import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const urlFor = (host, port) => `http://${host}:${port}`;

/** Directory holding laya-serve's own stdout/stderr log, exposed for diagnostics. */
export const LOG_DIR = join(tmpdir(), "laya-claude");
export const LAYA_SERVE_LOG = join(LOG_DIR, "laya-serve.log");

export async function checkHealth(healthUrl, { fetchFn = fetch, timeoutMs = 1000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(healthUrl, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForHealth(healthUrl, { timeoutMs = 30000, intervalMs = 500, fetchFn } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await checkHealth(healthUrl, { fetchFn })) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Spawns `laya-serve` detached (its own process group on POSIX) so it survives past
 * `laya-claude` exiting on its own if cleanup is ever skipped, logging its stdout/stderr to
 * a file since nothing is watching its console. `LAYA_SERVE_CMD` lets advanced users point at
 * a custom venv, e.g. `LAYA_SERVE_CMD="/opt/venv/bin/laya-serve"`.
 */
export function spawnLayaServe({ host, port, spawnFn = nodeSpawn } = {}) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFd = openSync(LAYA_SERVE_LOG, "a");
  const [cmd, ...args] = (process.env.LAYA_SERVE_CMD ?? "laya-serve").trim().split(/\s+/);
  const child = spawnFn(cmd, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      LAYA_HOST: host,
      LAYA_PORT: String(port),
      LAYA_DEVICE: process.env.LAYA_DEVICE ?? "cpu",
      LAYA_PRELOAD: process.env.LAYA_PRELOAD ?? "1",
    },
  });
  closeSync(logFd);
  child.unref?.();
  return child;
}

function stopChild(child) {
  if (child.pid == null) return;
  try {
    if (process.platform === "win32") {
      nodeSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      // Negative pid targets the whole process group `detached: true` created, reaching any
      // workers laya-serve forks, not just the immediate child.
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // Already gone, or we never had permission — nothing more to do on exit.
  }
}

/**
 * Ensures a `laya-serve` instance is reachable at `host:port`, starting one if needed.
 *
 * Never touches a server it did not start itself: `managed: false` means "leave it alone",
 * whether because it was already healthy or because autostart is disabled and it wasn't.
 *
 * @returns {Promise<{managed: false, unavailable?: true} | {managed: true, stop: () => void}>}
 */
export async function manageLayaServe({
  host,
  port,
  autostart,
  startupTimeoutMs = 30000,
  pollIntervalMs = 500,
  spawnFn,
  fetchFn,
} = {}) {
  const healthUrl = `${urlFor(host, port)}/health`;
  if (await checkHealth(healthUrl, { fetchFn })) return { managed: false };
  if (!autostart) return { managed: false, unavailable: true };

  const child = spawnLayaServe({ host, port, spawnFn });
  const healthy = await waitForHealth(healthUrl, {
    timeoutMs: startupTimeoutMs,
    intervalMs: pollIntervalMs,
    fetchFn,
  });
  if (!healthy) {
    stopChild(child);
    throw new Error(`laya-serve did not become healthy within ${startupTimeoutMs}ms — see ${LAYA_SERVE_LOG}`);
  }
  return { managed: true, stop: () => stopChild(child) };
}

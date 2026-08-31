// Shared harness for the headless-Chrome end-to-end tests
// (scripts/e2e-bundle.test.mjs, scripts/mobile-layout.test.mjs): locates
// Chrome, serves a directory with the COOP/COEP dev server for the duration
// of the test, and connects to a private headless Chrome over the DevTools
// protocol with a minimal CDP client.
//
// Chrome is located via $CHROME, well-known macOS app paths, and the usual
// google-chrome/chromium names on PATH. Callers run findChrome() first and
// skip with an explicit reason when it is missing.

import { accessSync, constants, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findChrome() {
  if (process.env.CHROME) {
    return isExecutable(process.env.CHROME) ? process.env.CHROME : null;
  }
  const appPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const path of appPaths) {
    if (isExecutable(path)) return path;
  }
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (isExecutable(path)) return path;
    }
  }
  return null;
}

/** Sleeps before each attempt, so the first probe runs after a tick. */
export async function waitUntil(predicate, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (await predicate()) return true;
  }
  return false;
}

/**
 * Starts the dev server (`serve` dir on `port`) and a headless Chrome with a
 * scratch profile, and waits until a CDP page target answers. Resolves to
 * { send, evaluate, close }; close() tears the processes and the profile
 * down and is safe to call from a finally block. Throws (after cleanup) if
 * an endpoint never comes up.
 *
 * Real timers only: no --virtual-time-budget, which fast-forwards timers
 * past the real async worker startup and trips the launcher's startup
 * watchdog artificially.
 */
export async function startChromeE2E({
  chrome,
  port,
  serve,
  debugPort,
  profilePrefix,
  headlessFlag = "--headless=new",
}) {
  const profileDir = join(
    process.env.TMPDIR || "/tmp",
    `${profilePrefix}-${process.pid}`,
  );
  const server = spawn(
    process.execPath,
    ["scripts/dev-server.mjs", String(port), serve],
    { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] },
  );
  let serverError = "";
  server.stderr.on("data", (chunk) => {
    serverError += String(chunk);
  });
  const browser = spawn(
    chrome,
    [
      headlessFlag,
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  // Chrome can still hold the scratch profile momentarily; the pid keeps
  // the next run from colliding with the leftovers.
  const close = () => {
    browser.kill();
    server.kill();
    try {
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    } catch {}
  };
  const fail = (message) => {
    close();
    throw new Error(message);
  };

  const serverUp = await waitUntil(async () => {
    try {
      return (await fetch(`http://localhost:${port}/`)).ok;
    } catch {
      return server.exitCode === null && browser.exitCode === null;
    }
  }, 50, 100);
  if (!serverUp) {
    fail(
      `dev server did not come up on port ${port}${serverError ? `: ${serverError}` : ""}`,
    );
  }

  let wsUrl = null;
  const endpointUp = await waitUntil(async () => {
    try {
      const targets = await (
        await fetch(`http://localhost:${debugPort}/json/list`)
      ).json();
      const page = targets.find((t) => t.type === "page");
      if (page) {
        wsUrl = page.webSocketDebuggerUrl;
        return true;
      }
    } catch {
      // Chrome not ready yet.
    }
    return false;
  }, 150, 100);
  if (!endpointUp) {
    fail(`Chrome DevTools endpoint did not come up on port ${debugPort}`);
  }

  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = (expression) =>
    send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }).then((result) => {
      if (result.exceptionDetails) {
        throw new Error(JSON.stringify(result.exceptionDetails));
      }
      return result.result?.value;
    });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", () =>
        reject(new Error("CDP WebSocket failed")),
      );
    });
  } catch (error) {
    ws.close();
    fail(error.message);
  }

  return { send, evaluate, close };
}

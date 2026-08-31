// End-to-end mobile-layout test for the bounded-terminal fix. Mirrors the
// shape of e2e-bundle.test.mjs: serves web/ from the dev server, drives
// headless Chrome over CDP with a phone-sized viewport and touch, and
// asserts the four invariants the bug violated:
//
//   1. The page never grows with the game output (no page scroll).
//   2. The terminal container's height is bounded (a constant across
//      turns, not a monotonically increasing number).
//   3. The terminal scrolls internally once the transcript overflows.
//   4. The prompt (the input line) is always within the visible viewport.
//
// It then stubs visualViewport before the page scripts run to simulate the
// soft keyboard (Chrome headless has no native keyboard emulation) and
// asserts the keyboard inset keeps the prompt in view.
//
// Chrome is located the same way as e2e-bundle.test.mjs. The test skips
// with an explicit reason when Chrome is missing.
//
// Usage:
//   /Users/minh/.workbuddy-ai/binaries/node/versions/22.22.2/bin/node --test scripts/mobile-layout.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2]) || 8903;

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findChrome() {
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
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (isExecutable(path)) return path;
    }
  }
  return null;
}

const CHROME = findChrome();
const skipReason = CHROME
  ? existsSync(join(repoRoot, "web", "index.html"))
    ? false
    : "web/ not built (the dev server serves it directly; this is a repo issue)"
  : "no Chrome found (set $CHROME to enable)";

async function waitUntil(predicate, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    // Sleep before each attempt so the first evaluate happens after the
    // page has had a chance to load (mirrors e2e-bundle.test.mjs).
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (await predicate()) return true;
  }
  return false;
}

// One snapshot returns every invariant we care about plus the current
// visualViewport so a test can decide whether the keyboard is "open" or
// "closed" without re-querying.
const SNAPSHOT = `(() => {
  const screen = document.getElementById('screen');
  const container = document.getElementById('terminal-container');
  const main = document.querySelector('main');
  const input = document.getElementById('terminal-input');
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top*100)/100, bottom: Math.round(b.bottom*100)/100, height: Math.round(b.height*100)/100 }; };
  const vv = window.visualViewport;
  const keyboardInset = main ? parseFloat(getComputedStyle(main).getPropertyValue('--keyboard-inset')) || 0 : 0;
  const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  // Probe the dynamic viewport height the CSS actually sees (viewport
  // units are resolved by the engine, not by window.visualViewport).
  const probe = document.createElement('div');
  probe.style.height = '100dvh';
  document.body.appendChild(probe);
  const dvh100 = probe.offsetHeight;
  probe.remove();
  const mainComputed = main ? getComputedStyle(main).height : null;
  return {
    doc: { scrollHeight: document.documentElement.scrollHeight, scrollTop: Math.round(document.documentElement.scrollTop), innerHeight: window.innerHeight, pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1 },
    vv: vv ? { height: Math.round(vv.height*100)/100, offsetTop: Math.round(vv.offsetTop*100)/100, scale: vv.scale } : null,
    dvh100, mainComputed, keyboardInset: Math.round(keyboardInset*100)/100,
    main: r(main),
    container: r(container),
    screen: { ...r(screen), clientHeight: Math.round(screen.clientHeight*100)/100, scrollHeight: Math.round(screen.scrollHeight*100)/100, scrollTop: Math.round(screen.scrollTop*100)/100, scrolls: screen.scrollHeight > screen.clientHeight + 1 },
    promptBottom: Math.round(input.getBoundingClientRect().bottom*100)/100,
    promptInView: input.getBoundingClientRect().bottom <= visibleBottom + 1,
    waiting: window.adventureDebug ? window.adventureDebug.state.waitingForInput : null,
  };
})()`;

// Replaces window.visualViewport with a stub before any page script runs,
// so launcher.js wires its listeners to the stub from the start. The
// stub exposes __setHeight / __setOffsetTop so the test can simulate the
// keyboard and the panning that accompanies it.
const VIEWPORT_STUB = `
(() => {
  let height = 844;
  let offsetTop = 0;
  const scale = 1;
  const listeners = { resize: [], scroll: [] };
  const vv = {
    get height() { return height; },
    get offsetTop() { return offsetTop; },
    get scale() { return scale; },
    get pageLeft() { return 0; },
    get pageTop() { return 0; },
    get width() { return 390; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type]; if (!list) return;
      const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1);
    },
    __setHeight(h) { height = h; for (const fn of listeners.resize) fn(); },
    __setOffsetTop(t) { offsetTop = t; for (const fn of listeners.scroll) fn(); },
  };
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
})();
`;

test(
  "mobile terminal: bounded box with internal scroll and visible prompt",
  { skip: skipReason, timeout: 120_000 },
  async () => {
    const debugPort = 9700 + (process.pid % 200);
    const profileDir = join(
      process.env.TMPDIR || "/tmp",
      `colossal-cave-mobile-profile-${process.pid}`,
    );
    const server = spawn(
      process.execPath,
      ["scripts/dev-server.mjs", String(port), "web"],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] },
    );
    let serverError = "";
    server.stderr.on("data", (chunk) => {
      serverError += String(chunk);
    });
    const browser = spawn(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDir}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );

    try {
      assert.ok(
        await waitUntil(async () => {
          try {
            return (await fetch(`http://localhost:${port}/`)).ok;
          } catch {
            return server.exitCode === null;
          }
        }, 50, 100),
        `dev server came up on port ${port}${serverError ? `: ${serverError}` : ""}`,
      );

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
        } catch {}
        return false;
      }, 150, 100);
      assert.ok(endpointUp, "Chrome DevTools endpoint came up");

      const cdp = await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let nextId = 0;
        const pending = new Map();
        const send = (method, params = {}) =>
          new Promise((res) => {
            const id = ++nextId;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method, params }));
          });
        const evaluate = (expression) =>
          send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
          }).then((r) => {
            if (r.exceptionDetails) {
              throw new Error(JSON.stringify(r.exceptionDetails));
            }
            return r.result.value;
          });
        ws.addEventListener("message", (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg.result);
            pending.delete(msg.id);
          }
        });
        ws.addEventListener("open", () => resolve({ send, evaluate }));
        ws.addEventListener("error", () => reject(new Error("CDP WebSocket failed")));
      });

      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      });
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
      // Install the visualViewport stub BEFORE the page scripts run, so
      // launcher.js wires its listeners to the stub from the start.
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: VIEWPORT_STUB,
      });
      await cdp.send("Page.navigate", { url: `http://localhost:${port}/` });

      // Boot.
      assert.ok(
        await waitUntil(async () => {
          const out = await cdp.evaluate(
            "document.getElementById('output').textContent || ''",
          );
          return /WELCOME TO ADVENTURE/.test(out);
        }, 180, 500),
        "game reached first output",
      );
      await new Promise((r) => setTimeout(r, 400));

      const commands = ["Y", "IN", "LOOK", "TAKE LAMP", "OUT"];
      const containerHeights = [];
      const snapshots = [];
      for (const cmd of commands) {
        assert.ok(
          await waitUntil(
            () => cdp.evaluate("window.adventureDebug.state.waitingForInput"),
            60,
            150,
          ),
          `prompt visible before command "${cmd}"`,
        );
        await cdp.send("Input.insertText", { text: cmd });
        await new Promise((r) => setTimeout(r, 120));
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await new Promise((r) => setTimeout(r, 700));
        const snap = await cdp.evaluate(SNAPSHOT);
        snapshots.push({ cmd, ...snap });
        containerHeights.push(snap.container.height);
      }

      // Invariant 1: the page never grows with the output.
      for (const s of snapshots) {
        assert.equal(
          s.doc.pageScrolls,
          false,
          `page should not scroll after "${s.cmd}" (doc.scrollHeight=${s.doc.scrollHeight}, innerHeight=${s.doc.innerHeight})`,
        );
      }

      // Invariant 2: the terminal container's height is bounded (a
      // constant, not a monotonically growing number).
      const heightSet = new Set(containerHeights);
      assert.equal(
        heightSet.size,
        1,
        `terminal container height should be constant, got ${JSON.stringify(containerHeights)}`,
      );
      const containerHeight = containerHeights[0];
      assert.ok(
        containerHeight > 200 && containerHeight < 800,
        `container height ${containerHeight} should be a usable phone-sized value`,
      );

      // Invariant 3: the terminal scrolls internally once the transcript
      // overflows the viewport.
      const last = snapshots[snapshots.length - 1];
      assert.ok(
        last.screen.scrolls,
        `screen should scroll internally (scrollHeight=${last.screen.scrollHeight}, clientHeight=${last.screen.clientHeight})`,
      );
      assert.ok(
        last.screen.scrollTop > 0,
        `screen should be scrolled down (scrollTop=${last.screen.scrollTop})`,
      );

      // Invariant 4: the prompt is always within the visible viewport.
      for (const s of snapshots) {
        assert.equal(
          s.promptInView,
          true,
          `prompt should be visible after "${s.cmd}" (promptBottom=${s.promptBottom}, visibleBottom=${s.vv ? s.vv.offsetTop + s.vv.height : s.doc.innerHeight})`,
        );
      }

      // Keyboard simulation: shrink the visual viewport and assert the
      // terminal shrinks in lockstep so the prompt stays in view.
      const before = await cdp.evaluate(SNAPSHOT);
      assert.equal(before.keyboardInset, 0, "no inset with the keyboard closed");
      // Open the keyboard: drop the visual viewport to roughly a phone
      // soft-keyboard size (about 300 px on an 844-px viewport).
      await cdp.evaluate("window.visualViewport.__setHeight(544)");
      await new Promise((r) => setTimeout(r, 250));
      const withKeyboard = await cdp.evaluate(SNAPSHOT);
      assert.ok(
        withKeyboard.keyboardInset > 200,
        `keyboard inset should track the ~300 px keyboard, got ${withKeyboard.keyboardInset}`,
      );
      // The main column shrank by roughly the inset, so the prompt rides
      // just above the new visible bottom.
      assert.ok(
        withKeyboard.main.height < before.main.height,
        `main should shrink when the keyboard opens (before=${before.main.height}, after=${withKeyboard.main.height})`,
      );
      assert.equal(
        withKeyboard.promptInView,
        true,
        `prompt should remain visible with the keyboard open (promptBottom=${withKeyboard.promptBottom}, visibleBottom=${withKeyboard.vv.offsetTop + withKeyboard.vv.height})`,
      );
      // Close the keyboard: the inset must relax back to 0.
      await cdp.evaluate("window.visualViewport.__setHeight(844)");
      await new Promise((r) => setTimeout(r, 250));
      const after = await cdp.evaluate(SNAPSHOT);
      assert.equal(after.keyboardInset, 0, "inset should return to 0 when the keyboard closes");
      assert.equal(after.promptInView, true);
    } finally {
      browser.kill();
      server.kill();
      try {
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Chrome can still hold the scratch profile momentarily.
      }
    }
  },
);

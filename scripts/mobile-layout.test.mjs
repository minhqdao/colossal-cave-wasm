// End-to-end mobile-layout test for the bounded-terminal fix. Uses the
// shared Chrome harness (scripts/chrome-e2e.mjs) to serve web/ and drive
// headless Chrome over CDP with a phone-sized viewport and touch, asserting
// the four invariants the bug violated:
//
//   1. The page never grows with the game output (no page scroll).
//   2. The terminal container's height is bounded (a constant across
//      turns, not a monotonically increasing number).
//   3. The terminal scrolls internally once the transcript overflows.
//   4. The prompt (the input line) is always within the visible viewport.
//
// Invariant 1 is what makes the mobile layout unusable if it breaks, and
// it is also the one that fights the browser's pull-to-refresh, which
// needs a scroll range to fire from. The page keeps a token range for it
// and nothing else, so the two hold at once.
//
// It then stubs visualViewport before the page scripts run to simulate the
// soft keyboard (headless Chrome has no native keyboard emulation) and
// asserts the keyboard inset keeps the prompt in view.
//
// Usage:
//   node --test scripts/mobile-layout.test.mjs [port]  (default 8903, web/ served)

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findChrome, startChromeE2E, waitUntil } from "./chrome-e2e.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2]) || 8903;

// Mirrors the main padding-bottom (min(Npx, keyboard-inset)) of the
// portrait block in web/index.html -- the device emulated below is
// portrait, so that is the rule under test. Keep in step with the CSS.
const BREATHING_ROOM_PX = 16;

const CHROME = findChrome();
const skipReason = CHROME
  ? existsSync(join(repoRoot, "web", "index.html"))
    ? false
    : "web/ is missing from the checkout"
  : "no Chrome found (set $CHROME to enable)";

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
    doc: {
      scrollHeight: document.documentElement.scrollHeight,
      scrollTop: Math.round(document.documentElement.scrollTop),
      innerHeight: window.innerHeight,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      overflow: getComputedStyle(document.documentElement).overflow,
      overscrollY: getComputedStyle(document.documentElement).overscrollBehaviorY,
      scrollRange: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    },
    screenOverscrollY: getComputedStyle(screen).overscrollBehaviorY,
    vv: vv ? { height: Math.round(vv.height*100)/100, offsetTop: Math.round(vv.offsetTop*100)/100, scale: vv.scale } : null,
    dvh100, mainComputed, keyboardInset: Math.round(keyboardInset*100)/100,
    main: r(main),
    container: r(container),
    screen: { ...r(screen), clientHeight: Math.round(screen.clientHeight*100)/100, scrollHeight: Math.round(screen.scrollHeight*100)/100, scrollTop: Math.round(screen.scrollTop*100)/100, scrolls: screen.scrollHeight > screen.clientHeight + 1 },
    promptBottom: Math.round(input.getBoundingClientRect().bottom*100)/100,
    promptInView: input.getBoundingClientRect().bottom <= visibleBottom + 1,
    actionsGap: Math.round((visibleBottom - document.querySelector('.terminal-actions').getBoundingClientRect().bottom)*100)/100,
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
  // A real visualViewport fires scroll when the document scrolls -- the
  // only way a page pan reaches the launcher. Forward it so a leaked
  // drag reproduces device behavior; offsetTop stays 0 as in Chrome.
  window.addEventListener('scroll', () => {
    for (const fn of listeners.scroll) fn();
  }, true);
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
})();
`;

test(
  "mobile terminal: bounded box with internal scroll and visible prompt",
  { skip: skipReason, timeout: 120_000 },
  async () => {
    const e2e = await startChromeE2E({
      chrome: CHROME,
      port,
      serve: "web",
      debugPort: 9700 + (process.pid % 200),
      profilePrefix: "colossal-cave-mobile-profile",
    });
    try {
      await e2e.send("Page.enable");
      await e2e.send("Runtime.enable");
      await e2e.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      });
      await e2e.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
      // Install the visualViewport stub BEFORE the page scripts run, so
      // launcher.js wires its listeners to the stub from the start.
      await e2e.send("Page.addScriptToEvaluateOnNewDocument", {
        source: VIEWPORT_STUB,
      });
      await e2e.send("Page.navigate", { url: `http://localhost:${port}/` });

      // Boot. The page may still be mid-navigation when the first probe
      // runs, so a throwing evaluate just means "keep waiting".
      assert.ok(
        await waitUntil(async () => {
          try {
            const out = await e2e.evaluate(
              "document.getElementById('output').textContent || ''",
            );
            return /WELCOME TO ADVENTURE/.test(out);
          } catch {
            return false;
          }
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
            () => e2e.evaluate("window.adventureDebug.state.waitingForInput"),
            60,
            150,
          ),
          `prompt visible before command "${cmd}"`,
        );
        await e2e.send("Input.insertText", { text: cmd });
        await new Promise((r) => setTimeout(r, 120));
        await e2e.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await e2e.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await new Promise((r) => setTimeout(r, 700));
        const snap = await e2e.evaluate(SNAPSHOT);
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
        // Pull-to-refresh contract: it fires from a top overscroll of the
        // document, so the root must be neither clipped nor opted out,
        // and must have a range to overscroll -- browsers drop it on a
        // page with nothing to scroll. The range stays a token (one px),
        // which is why invariant 1 still holds.
        assert.equal(
          s.doc.overflow,
          "visible",
          `clipping the root kills pull-to-refresh (overflow=${s.doc.overflow})`,
        );
        assert.equal(
          s.doc.overscrollY,
          "auto",
          `overscroll-behavior: none is the pull-to-refresh opt-out (overscrollY=${s.doc.overscrollY})`,
        );
        assert.ok(
          s.doc.scrollRange > 0,
          `document needs a scroll range for pull-to-refresh (scrollHeight=${s.doc.scrollHeight}, clientHeight=${s.doc.scrollHeight - s.doc.scrollRange})`,
        );
        assert.ok(
          s.doc.scrollRange <= 2,
          `the pull-to-refresh range should be a token, got ${s.doc.scrollRange} px`,
        );
        assert.equal(
          s.screenOverscrollY,
          "auto",
          `the terminal is most of the page: it must not opt out of pull-to-refresh (overscrollY=${s.screenOverscrollY})`,
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
      const before = await e2e.evaluate(SNAPSHOT);
      assert.equal(before.keyboardInset, 0, "no inset with the keyboard closed");
      // Open the keyboard: drop the visual viewport to roughly a phone
      // soft-keyboard size (about 300 px on an 844-px viewport).
      await e2e.evaluate("window.visualViewport.__setHeight(544)");
      await new Promise((r) => setTimeout(r, 250));
      const withKeyboard = await e2e.evaluate(SNAPSHOT);
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
      // The buttons sit the padding-bottom clear of the keyboard, and
      // lose that padding again once it closes.
      assert.ok(
        withKeyboard.actionsGap >= BREATHING_ROOM_PX - 1 &&
          withKeyboard.actionsGap <= BREATHING_ROOM_PX + 1,
        `buttons should clear the keyboard by ${BREATHING_ROOM_PX} px, got ${withKeyboard.actionsGap}`,
      );
      // The document locks for exactly the keyboard-open window: Chrome
      // inflates the pull-to-refresh range with the keyboard, so leaving
      // it spendable lets a background drag scroll behind the fixed main.
      assert.equal(
        withKeyboard.doc.overflow,
        "hidden",
        `document should lock while the keyboard is open (overflow=${withKeyboard.doc.overflow})`,
      );
      assert.equal(
        withKeyboard.doc.overscrollY,
        "none",
        `document should opt out of overscroll while the keyboard is open (overscrollY=${withKeyboard.doc.overscrollY})`,
      );
      // Close the keyboard: the inset must relax back to 0.
      await e2e.evaluate("window.visualViewport.__setHeight(844)");
      await new Promise((r) => setTimeout(r, 250));
      const after = await e2e.evaluate(SNAPSHOT);
      assert.equal(after.keyboardInset, 0, "inset should return to 0 when the keyboard closes");
      assert.equal(after.promptInView, true);
      assert.equal(
        after.actionsGap,
        before.actionsGap,
        `keyboard closing should restore the buttons' gap (before=${before.actionsGap}, after=${after.actionsGap})`,
      );
      // The lock releases with the keyboard: pull-to-refresh must work
      // again the moment it is meaningful again.
      assert.equal(
        after.doc.overflow,
        "visible",
        `document should unlock once the keyboard closes (overflow=${after.doc.overflow})`,
      );
      assert.equal(
        after.doc.overscrollY,
        "auto",
        `pull-to-refresh should return once the keyboard closes (overscrollY=${after.doc.overscrollY})`,
      );

      // Regression: with the keyboard open, a background drag must not
      // resize the terminal (a panned main reads to the inset measurement
      // as "the keyboard moved") nor scroll the document (Chrome inflates
      // the pull-to-refresh range to the keyboard's height while it is
      // up, and a fixed main never follows body's scrollTop -- the gap
      // only shows as moved background). The emulated keyboard does not
      // shrink the layout viewport, so the drag proof below forces the
      // same inflated range the real keyboard would.
      await e2e.evaluate("window.visualViewport.__setHeight(544)");
      await new Promise((r) => setTimeout(r, 250));
      const beforeDrag = await e2e.evaluate(SNAPSHOT);

      // Regression: panning with the keyboard up must not resize the
      // terminal. main is pinned, so moving the visible region moves the
      // measurement without moving main; without the hold, the terminal
      // grows by the pan distance and the layout breathes on every drag
      // (and on iOS, on every rubber-band).
      await e2e.evaluate("window.visualViewport.__setOffsetTop(40)");
      await new Promise((r) => setTimeout(r, 250));
      const panned = await e2e.evaluate(SNAPSHOT);
      assert.equal(
        panned.vv.offsetTop,
        40,
        `the pan should have applied (offsetTop=${panned.vv.offsetTop})`,
      );
      assert.equal(
        panned.container.height,
        beforeDrag.container.height,
        `panning must not resize the terminal (before=${beforeDrag.container.height}, after=${panned.container.height})`,
      );
      assert.equal(
        panned.keyboardInset,
        beforeDrag.keyboardInset,
        `panning must not change the keyboard inset (before=${beforeDrag.keyboardInset}, after=${panned.keyboardInset})`,
      );
      await e2e.evaluate("window.visualViewport.__setOffsetTop(0)");
      await new Promise((r) => setTimeout(r, 250));

      // Spend the scroll range the keyboard would have inflated: bump the
      // document well past the (stubbed) visible area, the way Chrome's
      // keyboard does by shrinking the layout viewport under the fixed
      // lvh base. Without the lock this leaves real range to spend.
      const inflatedRange = await e2e.evaluate(`(() => {
        document.documentElement.style.minHeight = '2000px';
        return document.documentElement.scrollHeight -
          document.documentElement.clientHeight;
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      // Body padding above the title: outside the terminal, on the page.
      await e2e.send("Input.synthesizeScrollGesture", {
        x: 195,
        y: 8,
        xDistance: 0,
        yDistance: -220,
        gestureSourceType: "touch",
        speed: 800,
      });
      await new Promise((r) => setTimeout(r, 300));
      const afterDrag = await e2e.evaluate(SNAPSHOT);
      // The actual bug: with range to spend, this drag moved the document
      // and left bare body background below the buttons. The lock must
      // have clipped it -- scrollTop, not main (fixed, so it never
      // follows the scroll either way), is what records page movement.
      assert.ok(
        inflatedRange > 200,
        `the forced range should exist to be clipped (got ${inflatedRange} px)`,
      );
      assert.equal(
        afterDrag.doc.scrollTop,
        beforeDrag.doc.scrollTop,
        `background drag should not scroll the locked document (before=${beforeDrag.doc.scrollTop}, after=${afterDrag.doc.scrollTop})`,
      );
      assert.equal(
        afterDrag.container.height,
        beforeDrag.container.height,
        `background drag should not resize the terminal (before=${beforeDrag.container.height}, after=${beforeDrag.container.height})`,
      );
      assert.equal(
        afterDrag.keyboardInset,
        beforeDrag.keyboardInset,
        `background drag should not change the keyboard inset (before=${beforeDrag.keyboardInset}, after=${afterDrag.keyboardInset})`,
      );
      await e2e.evaluate(
        "document.documentElement.style.minHeight = ''",
      );
    } finally {
      e2e.close();
    }
  },
);

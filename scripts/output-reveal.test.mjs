// Output auto-reveal tests (mobile page-scroll layout): when a game turn's
// output completes, the page must scroll the new block into view --
// bottom-aligned when it fits on screen, from its beginning when it is
// taller than the screen -- and must do nothing when the user took over
// scrolling or when #screen owns the scrolling (desktop).
//
// The jsdom harness mocks a fixed layout (document coordinates, css px):
// the terminal block starts at y=200, the visible viewport is 768 high
// (jsdom's window.innerHeight default); the action row sits 20px under the
// terminal and is 48px tall, and the reveal adds 16px of breathing room, so
// bottom-aligned targets keep 84px of footer space above the fold.
//
// jsdom lives in a scratch node_modules (see scripts/browser-smoke.sh); the
// test skips gracefully when it has not been installed.
//
//   node --test scripts/output-reveal.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { pageRevealTarget } from "../web/terminal-scroll.js";

const require = createRequire(import.meta.url);

function resolveJSDOM() {
  const scratch = process.env.SMOKE_NODE_MODULES;
  if (!scratch) return null;
  try {
    return require(join(scratch, "jsdom")).JSDOM;
  } catch {
    return null;
  }
}

const JSDOM = resolveJSDOM();

test("pageRevealTarget: blocks that fit are bottom-aligned", () => {
  assert.equal(
    pageRevealTarget({
      currentScrollY: 0,
      blockTop: 200,
      blockBottom: 800,
      visibleHeight: 768,
      reserve: 64,
      maxScroll: 5000,
    }),
    96, // 800 + 64 - 768: the block ends 64px above the fold
  );
});

test("pageRevealTarget: taller-than-screen blocks anchor at their beginning", () => {
  assert.equal(
    pageRevealTarget({
      currentScrollY: 0,
      blockTop: 200,
      blockBottom: 1900,
      visibleHeight: 768,
      reserve: 64,
      maxScroll: 5000,
    }),
    200,
  );
});

test("pageRevealTarget: never moves up, never past the document end", () => {
  assert.equal(
    pageRevealTarget({
      currentScrollY: 500,
      blockTop: 200,
      blockBottom: 700,
      visibleHeight: 768,
      reserve: 64,
      maxScroll: 5000,
    }),
    500,
  );
  assert.equal(
    pageRevealTarget({
      currentScrollY: 0,
      blockTop: 5000,
      blockBottom: 9000,
      visibleHeight: 768,
      reserve: 64,
      maxScroll: 4200,
    }),
    4200,
  );
});

if (!JSDOM) {
  console.warn(
    "output-reveal.test.mjs integration scenarios skipped: run scripts/browser-smoke.sh (installs jsdom into a scratch cache directory)",
  );
  test("jsdom scratch install missing", { skip: true }, () => {});
}

if (JSDOM) {
  const indexUrl = new URL("../web/index.html", import.meta.url);
  let scenarioCount = 0;

  async function openRevealPage({ touch = true } = {}) {
    scenarioCount += 1;
    const html = readFileSync(indexUrl, "utf8");
    const dom = new JSDOM(html, {
      url: "http://localhost/",
      pretendToBeVisual: true,
      runScripts: "outside-only",
    });
    const { window } = dom;
    const document = window.document;

    const pointerMatch = {
      matches: touch,
      addEventListener() {},
      removeEventListener() {},
    };
    window.crossOriginIsolated = true;
    window.matchMedia = (query) =>
      query.includes("coarse") ? pointerMatch : { matches: false };

    // Mocked layout document. #screen's scroll metrics stay 0/0, which is
    // precisely the page-scroll-mode condition the launcher detects.
    const layout = {
      terminalTop: 200,
      terminalBottom: 200,
      documentHeight: 500,
    };
    const rect = (top, bottom) => ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 390,
      bottom,
      height: bottom - top,
      width: 390,
      toJSON() {},
    });
    window.Element.prototype.getBoundingClientRect = function () {
      if (this === document.getElementById("terminal")) {
        return rect(layout.terminalTop, layout.terminalBottom);
      }
      if (this === document.querySelector(".terminal-actions")) {
        return rect(layout.terminalBottom + 20, layout.terminalBottom + 68);
      }
      return rect(0, 0);
    };
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      get: () => layout.documentHeight,
    });

    const scrollToCalls = [];
    window.scrollTo = (_x, y) => {
      scrollToCalls.push(y);
    };
    // Pin the viewport model to the window fallback (jsdom's innerHeight).
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });

    class FakeGameWorker {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
        this.dead = false;
      }
      emit(data) {
        if (!this.dead) this.onmessage?.({ data });
      }
      postMessage(command) {
        if (command.type === "INIT") {
          setTimeout(() => this.emit({ type: "READY" }), 0);
        } else if (command.type === "START") {
          setTimeout(() => this.emit({ type: "STARTED" }), 0);
          setTimeout(() => this.emit({ type: "REQUEST_INPUT" }), 0);
        }
      }
      terminate() {
        this.dead = true;
      }
    }

    globalThis.window = window;
    globalThis.document = document;
    globalThis.sessionStorage = window.sessionStorage;
    globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    globalThis.Worker = FakeGameWorker;

    await import(`../web/launcher.js?reveal=${scenarioCount}`);

    const waitFor = async (predicate, attempts = 50) => {
      for (let i = 0; i < attempts; i++) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return predicate();
    };
    assert.ok(
      await waitFor(
        () =>
          window.adventureDebug.state.worker !== undefined &&
          window.adventureDebug.state.waitingForInput,
      ),
      "launcher did not reach the waiting-for-input prompt",
    );

    const worker = window.adventureDebug.state.worker;
    // The boot turn ends with no output at all: revealing nothing is nothing.
    assert.deepEqual(scrollToCalls, []);

    /**
     * One full game turn: stream `blockHeight` px of output (one STDOUT
     * event), optionally right before REQUEST_INPUT, then finish the turn.
     */
    // The reveal applies on the second animation frame after the turn ends.
    const settleReveal = () =>
      new Promise((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => setTimeout(resolve, 0));
        });
      });

    const takeTurn = async (blockHeight, { beforePrompt } = {}) => {
      const from = layout.terminalBottom;
      if (blockHeight > 0) {
        layout.terminalBottom = from + blockHeight;
        layout.documentHeight += blockHeight;
        worker.emit({ type: "STDOUT", text: `x`.repeat(blockHeight) });
      }
      beforePrompt?.();
      worker.emit({ type: "REQUEST_INPUT" });
      await waitFor(() => window.adventureDebug.state.waitingForInput === true);
      await settleReveal();
    };

    const submit = async (text) => {
      const input = document.getElementById("terminal-input");
      input.value = text;
      input.dispatchEvent(
        Object.assign(new window.Event("input", { bubbles: true }), {
          inputType: "insertText",
        }),
      );
      assert.ok(window.adventureDebug.state.waitingForInput);
      input.dispatchEvent(
        Object.assign(
          new window.Event("keydown", { bubbles: true, cancelable: true }),
          { key: "Enter" },
        ),
      );
      assert.ok(!window.adventureDebug.state.waitingForInput);
      // The echoed command line grows the transcript by one terminal line;
      // the launcher marked the block at the previous bottom BEFORE this,
      // so the echo belongs to the new block (the reading anchor is the
      // user's own command).
      layout.terminalBottom += 17;
      layout.documentHeight += 17;
    };

    return { window, document, takeTurn, submit, scrollToCalls, layout };
  }

  // Layout: visible height 768, footer reserve 84 (20px prompt-row gap +
  // 48px action row + 16px margin), usable content height 684; page
  // starts at scrollY 0 with the terminal at y 200.

  test("tall intro reveals from its beginning; the next turn bottom-aligns", async () => {
    const { takeTurn, submit, scrollToCalls } = await openRevealPage();
    // Intro occupies y 200..1700 (taller than usable) -> begin anchor at 200.
    await takeTurn(1500);
    assert.deepEqual(scrollToCalls, [200]);
    // Submit echoes at 1700..1717, then a 600px reply: the block
    // (y 1700..2317) fits the screen -> bottom-aligns the action row
    // flush with the fold.
    await submit("N");
    assert.equal(scrollToCalls.length, 1, "submitting alone never scrolls");
    await takeTurn(600);
    assert.deepEqual(scrollToCalls, [200, 2317 + 84 - 768]);
  });

  test("output already on screen does not move; growth past the fold does", async () => {
    const { takeTurn, submit, scrollToCalls } = await openRevealPage();
    await takeTurn(300); // y 200..500: fully visible at rest -> no scroll
    assert.deepEqual(scrollToCalls, []);
    await submit("LOOK");
    await takeTurn(500); // y 500..1017: fits, crosses the fold -> bottom-align
    assert.deepEqual(scrollToCalls, [1017 + 84 - 768]);
  });

  test("a user touch-scroll during the turn cancels the reveal", async () => {
    const { window, takeTurn, scrollToCalls } = await openRevealPage();
    await takeTurn(1500, {
      beforePrompt: () => {
        window.dispatchEvent(new window.Event("touchmove", { bubbles: true }));
      },
    });
    assert.deepEqual(scrollToCalls, []);
  });

  test("a wheel during the turn cancels the reveal", async () => {
    const { window, takeTurn, scrollToCalls } = await openRevealPage();
    await takeTurn(1500, {
      beforePrompt: () => {
        window.dispatchEvent(new window.Event("wheel", { bubbles: true }));
      },
    });
    assert.deepEqual(scrollToCalls, []);
  });

  test("after a takeover the next submitted turn is tracked again", async () => {
    const { window, takeTurn, submit, scrollToCalls } = await openRevealPage();
    await takeTurn(1500, {
      beforePrompt: () => {
        window.dispatchEvent(new window.Event("touchmove", { bubbles: true }));
      },
    });
    assert.deepEqual(scrollToCalls, []);
    // New block marked (takeover re-armed) at the post-intro bottom,
    // y 1700..3217: too tall -> begin anchor at its top.
    await submit("N");
    await takeTurn(1500);
    assert.deepEqual(scrollToCalls, [1700]);
  });

  test("desktop (internal #screen scroller) never page-reveals", async () => {
    const { takeTurn, submit, scrollToCalls } = await openRevealPage({
      touch: false,
    });
    await takeTurn(2000);
    await submit("N");
    await takeTurn(2000);
    assert.deepEqual(scrollToCalls, []);
  });
}

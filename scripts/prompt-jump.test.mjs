// Prompt-visibility jump tests: when the game finishes outputting text and
// the prompt line is NOT fully visible (off-screen, or above the fold but
// under the soft keyboard), the page jumps exactly far enough to bottom the
// prompt -- mirroring what the browser does natively once the user types.
// When the prompt is already visible, nothing may scroll: no jank.
//
// The jsdom harness mocks a fixed layout (document coordinates, css px):
// the boot turn leaves the prompt bottom at y=200 (innerHeight is 768),
// and each streamed block grows the terminal and the document together.
//
// jsdom lives in a scratch node_modules (see scripts/browser-smoke.sh); the
// test skips gracefully when it has not been installed.
//
//   node --test scripts/prompt-jump.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { keyboardHeight, promptJumpTarget } from "../web/terminal-scroll.js";

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

test("keyboardHeight: covers window minus visual viewport", () => {
  assert.equal(
    keyboardHeight({ innerHeight: 768, visualHeight: 768 }),
    0, // closed, or Android Chrome (keyboard resizes the layout viewport)
  );
  assert.equal(
    keyboardHeight({
      innerHeight: 844,
      visualHeight: 600,
      visualTopOffsetTop: 44,
    }),
    200,
  );
  assert.equal(
    keyboardHeight({
      innerHeight: 768,
      visualHeight: 420,
      visualTopOffsetTop: 88,
    }),
    260,
  );
});

test("promptJumpTarget: returns null while the prompt is fully visible", () => {
  assert.equal(
    promptJumpTarget({
      currentScrollY: 0,
      visualHeight: 768,
      promptBottom: 500,
      maxScroll: 3000,
    }),
    null,
  );
  // Sitting exactly on the fold counts as visible.
  assert.equal(
    promptJumpTarget({
      currentScrollY: 0,
      visualHeight: 768,
      promptBottom: 768,
      maxScroll: 3000,
    }),
    null,
  );
});

test("promptJumpTarget: below the fold aligns the prompt to the fold", () => {
  assert.equal(
    promptJumpTarget({
      currentScrollY: 0,
      visualHeight: 768,
      promptBottom: 1000,
      maxScroll: 3000,
    }),
    1000 - 768,
  );
});

test("promptJumpTarget: a keyboard-shrunk viewport counts as hidden", () => {
  assert.equal(
    // Prompt is on the layout viewport but below the keyboard's top edge.
    promptJumpTarget({
      currentScrollY: 0,
      visualTopOffsetTop: 88,
      visualHeight: 420,
      promptBottom: 600,
      maxScroll: 3000,
    }),
    600 - 88 - 420,
  );
});

test("promptJumpTarget: never scrolls past the document bottom", () => {
  assert.equal(
    promptJumpTarget({
      currentScrollY: 0,
      visualHeight: 768,
      promptBottom: 5000,
      maxScroll: 4200,
    }),
    4200,
  );
});

if (!JSDOM) {
  console.warn(
    "prompt-jump.test.mjs integration scenarios skipped: run scripts/browser-smoke.sh (installs jsdom into a scratch cache directory)",
  );
  test("jsdom scratch install missing", { skip: true }, () => {});
}

if (JSDOM) {
  const indexUrl = new URL("../web/index.html", import.meta.url);
  let scenarioCount = 0;

  async function openPromptJumpPage({ viewport } = {}) {
    scenarioCount += 1;
    const html = readFileSync(indexUrl, "utf8");
    const dom = new JSDOM(html, {
      url: "http://localhost/",
      pretendToBeVisual: true,
      runScripts: "outside-only",
    });
    const { window } = dom;
    const document = window.document;

    window.crossOriginIsolated = true;
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    });
    // jsdom's innerHeight (768) is the layout viewport; `viewport` (plain
    // { height, offsetTop } with mutable fields) models the visual
    // viewport, e.g. { height: 420, offsetTop: 88 } with the keyboard open.
    const viewportListeners = [];
    const registeredViewport = viewport
      ? {
          ...viewport,
          addEventListener(_type, callback) {
            viewportListeners.push(callback);
          },
          removeEventListener() {},
        }
      : undefined;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: registeredViewport,
    });

    const layout = {
      promptBottom: 200,
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
      if (this === document.getElementById("input")) {
        return rect(layout.promptBottom - 17, layout.promptBottom);
      }
      return rect(0, 0);
    };
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      // The keyboard spacer (padding-bottom) genuinely grows the
      // scrollable area; mirror that so jump targets see a realistic
      // maxScroll while the keyboard is open.
      get: () =>
        layout.documentHeight +
        (parseFloat(document.documentElement.style.paddingBottom) || 0),
    });

    const scrollToCalls = [];
    window.scrollTo = (_x, y) => {
      scrollToCalls.push(y);
    };

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

    await import(`../web/launcher.js?jump=${scenarioCount}`);

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

    // The boot turn has a visible prompt: nothing may scroll.
    await settleJump(window);
    assert.deepEqual(scrollToCalls, [], "visible prompt must not move the page");

    const worker = window.adventureDebug.state.worker;

    /** One game turn: grow the prompt line by `blockHeight` px, finish it. */
    const takeTurn = async (blockHeight) => {
      layout.promptBottom += blockHeight;
      layout.documentHeight += blockHeight;
      worker.emit({ type: "STDOUT", text: `x`.repeat(blockHeight) });
      worker.emit({ type: "REQUEST_INPUT" });
      await waitFor(() => window.adventureDebug.state.waitingForInput === true);
      await settleJump(window);
    };

    const spacerHeight = () =>
      parseFloat(document.documentElement.style.paddingBottom) || 0;

    /** Simulate the soft keyboard rising: mutate the mock, then fire resize. */
    const openKeyboard = async (height, offsetTop = 0) => {
      registeredViewport.height = height;
      registeredViewport.offsetTop = offsetTop;
      for (const listener of viewportListeners) listener();
      await settleJump(window);
      await settleJump(window); // the reveal is re-scheduled, allow extra frames
    };

    return {
      window,
      takeTurn,
      scrollToCalls,
      layout,
      spacerHeight,
      openKeyboard,
    };
  }

  // The jump applies on the second animation frame after the turn ends.
  function settleJump(window) {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => setTimeout(resolve, 0));
      });
    });
  }

  test("turns whose prompt stays on screen never scroll the page", async () => {
    const { takeTurn, scrollToCalls } = await openPromptJumpPage();
    await takeTurn(300); // prompt bottom 500, above the 768 fold
    await takeTurn(250); // ...and so on while everything fits
    assert.deepEqual(scrollToCalls, []);
  });

  test("the first turn that pushes the prompt past the fold jumps once", async () => {
    const { takeTurn, scrollToCalls, layout } = await openPromptJumpPage();
    await takeTurn(700); // prompt bottom 900 > 768
    assert.deepEqual(scrollToCalls, [900 - 768]);
    // A further turn re-evaluates from scratch (scrollY stays mocked at 0,
    // so the new prompt bottom simply needs more of a jump).
    await takeTurn(100);
    assert.deepEqual(scrollToCalls, [900 - 768, 1000 - 768]);
  });

  test("prompt hidden under an already-open keyboard jumps to its top edge", async () => {
    // Keyboard open at turn end: layout stays 768, only y=88..508 visible.
    const { takeTurn, scrollToCalls, spacerHeight } = await openPromptJumpPage({
      viewport: { height: 420, offsetTop: 88 },
    });
    // The boot-turn reveal already reserves the keyboard slice -- always
    // harmless: it sits at the document bottom, i.e. behind the keyboard.
    assert.equal(spacerHeight(), 260);
    await takeTurn(350); // prompt bottom 550: on-screen layout-wise...
    // ...but under the keyboard: without the spacer, maxScroll (850-768)
    // would clamp the jump to 82 and leave the prompt still covered.
    assert.deepEqual(scrollToCalls, [550 - 88 - 420]);
  });

  test("a keyboard that opens after the turn re-reveals the prompt", async () => {
    // The turn ended while everything fit; iOS then raises the keyboard
    // over the prompt line asynchronously.
    const { takeTurn, scrollToCalls, spacerHeight, openKeyboard } =
      await openPromptJumpPage({ viewport: { height: 768, offsetTop: 0 } });
    await takeTurn(350); // prompt bottom 550 < 768 fold: no jump yet
    assert.deepEqual(scrollToCalls, []);
    await openKeyboard(420); // keyboard 348px tall covers the prompt
    assert.deepEqual(scrollToCalls, [550 - 420]);
    assert.equal(spacerHeight(), 768 - 420);
  });

  test("no viewport API (desktop) never reserves space or scrolls", async () => {
    const { takeTurn, scrollToCalls, spacerHeight } = await openPromptJumpPage();
    await takeTurn(700); // normal past-fold jump still works...
    assert.deepEqual(scrollToCalls, [900 - 768]);
    assert.equal(spacerHeight(), 0); // ...without any keyboard spacer
  });
}

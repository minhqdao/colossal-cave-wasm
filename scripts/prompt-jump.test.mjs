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

import { promptJumpTarget } from "../web/terminal-scroll.js";

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
    // jsdom's innerHeight (768) is the layout viewport; `viewport` models
    // the visual viewport (e.g. {{ height: 420, offsetTop: 88 }} with the
    // soft keyboard open).
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
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
      get: () => layout.documentHeight,
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

    return { window, takeTurn, scrollToCalls, layout };
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

  test("prompt hidden under the keyboard jumps to the keyboard top edge", async () => {
    // Visual viewport shrunk by the keyboard: layout 768 stays, but only
    // y=88..508 are actually visible.
    const { takeTurn, scrollToCalls } = await openPromptJumpPage({
      viewport: {
        height: 420,
        offsetTop: 88,
        addEventListener() {},
        removeEventListener() {},
      },
    });
    await takeTurn(350); // prompt bottom 550: on-screen layout-wise...
    assert.deepEqual(scrollToCalls, [550 - 88 - 420]); // ...but under the keyboard
  });
}

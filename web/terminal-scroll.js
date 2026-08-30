// @ts-check

/**
 * Scrolls the terminal viewport to its latest content.
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} screen
 */
export function scrollTerminalToBottom(screen) {
  if (screen.scrollHeight > screen.clientHeight) {
    screen.scrollTop = screen.scrollHeight;
  }
}

/**
 * Bottom-most scroll position (in document coordinates) that brings the
 * prompt line fully above the fold -- used on mobile page-scroll layouts
 * where the whole document is the scrollable surface.
 *
 * @param {Object} viewport
 * @param {number} viewport.currentScrollY scroll offset of the layout viewport
 * @param {number} viewport.visualTopOffsetTop visual viewport inset below the layout viewport top (keyboard pan)
 * @param {number} viewport.visualHeight visual viewport height (smaller than the window while the keyboard is open)
 * @param {number} viewport.promptBottom document y of the prompt line's bottom edge
 * @param {number} viewport.maxScroll largest scroll offset the document allows
 * @returns {number | null} new layout scrollY for the jump, or
 *   null when the prompt is already fully visible.
 */
export function promptJumpTarget({
  currentScrollY,
  visualTopOffsetTop = 0,
  visualHeight,
  promptBottom,
  maxScroll,
}) {
  const fold = currentScrollY + visualTopOffsetTop + visualHeight;
  if (promptBottom <= fold) return null;
  // Jump exactly far enough for the prompt bottom to land on the fold;
  // clamp to the document bottom (a short document cannot scroll further,
  // which mirrors what the browser itself does when typing).
  return Math.min(
    Math.max(0, promptBottom - visualTopOffsetTop - visualHeight),
    maxScroll,
  );
}

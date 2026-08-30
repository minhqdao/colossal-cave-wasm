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
 * Height of the soft keyboard: the slice of the layout viewport the visual
 * viewport cannot see. Zero on desktop and on Android Chrome (whose
 * keyboard resizes the layout viewport instead of covering it), hundreds
 * of pixels on iOS.
 *
 * @param {Object} viewport
 * @param {number} viewport.innerHeight layout viewport height
 * @param {number} viewport.visualHeight visual viewport height
 * @param {number} [viewport.visualTopOffsetTop] visual viewport offset from the layout viewport top
 */
export function keyboardHeight({
  innerHeight,
  visualHeight,
  visualTopOffsetTop = 0,
}) {
  return Math.max(0, innerHeight - visualTopOffsetTop - visualHeight);
}

/**
 * Bottom-most scroll position (in document coordinates) that brings the
 * prompt line fully above the fold -- used on mobile page-scroll layouts
 * where the whole document is the scrollable surface. The fold is the
 * visual viewport's bottom edge, i.e. the top edge of the soft keyboard
 * while it is open.
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
  // Jump exactly far enough for the prompt bottom to land on the fold.
  // The browser itself clamps a scrollTo past the scrollable area, and a
  // short layout viewport (Android) simply has more scrollable room, so
  // the keyboard reveal "bottom + keyboard height" works out to the same
  // fold-aligned number on both platforms.
  return Math.min(
    Math.max(0, promptBottom - visualTopOffsetTop - visualHeight),
    maxScroll,
  );
}

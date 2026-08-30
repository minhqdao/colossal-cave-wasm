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
 * Bottom-most scroll position (in document
 * coordinates) that raises the cursor to a fixed distance above the fold
 * -- used on mobile page-scroll layouts where the whole document is the
 * scrollable surface. The fold is the visual viewport's bottom edge: the
 * window bottom while the keyboard is closed, its top edge while open.
 *
 * @param {Object} viewport
 * @param {number} viewport.currentScrollY scroll offset of the layout viewport
 * @param {number} viewport.visualTopOffsetTop visual viewport inset below the layout viewport top (keyboard pan)
 * @param {number} viewport.visualHeight visual viewport height (smaller than the window while the keyboard is open)
 * @param {number} viewport.revealBottom document y of the cursor line's bottom edge
 * @param {number} [viewport.revealPadding] space kept below the cursor before the fold
 * @param {number} viewport.maxScroll largest scroll offset the document allows
 * @returns {number | null} new layout scrollY for the jump, or
 *   null when the cursor + padding is already fully visible.
 */
export function promptJumpTarget({
  currentScrollY,
  visualTopOffsetTop = 0,
  visualHeight,
  revealBottom,
  revealPadding = 0,
  maxScroll,
}) {
  const fold = currentScrollY + visualTopOffsetTop + visualHeight;
  if (revealBottom + revealPadding <= fold) return null;
  // Jump exactly far enough for the cursor (plus the reveal padding) to
  // land on the fold. On Android the keyboard shrinks the layout
  // viewport, so aligning the cursor to that fold is "bottom + keyboard
  // height" in window terms already.
  return Math.min(
    Math.max(0, revealBottom + revealPadding - visualTopOffsetTop - visualHeight),
    maxScroll,
  );
}

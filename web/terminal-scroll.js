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
 * Where a completed output block should be revealed in page-scroll layout
 * (mobile): the document, not #screen, is the scroll container there, so
 * new output "grows past the bottom" unless it is explicitly revealed.
 *
 * Chat/terminal convention, resolved per block by what actually fits:
 * - A block that fits between its start and the bottom of the viewport is
 *   bottom-aligned: the whole block plus the follow-up prompt are on
 *   screen at once (nothing is cut off, so this subsumes the "keep the
 *   prompt in view" option).
 * - A taller block is anchored at its beginning instead, so the reader
 *   starts a long room description at the top with the screen's full
 *   real estate and keeps natural downward scrolling; bottom-aligning it
 *   would hide its first lines above the fold.
 * - The reveal only ever moves the viewport down, and it is a no-op when
 *   the block is already fully visible.
 *
 * Pure function of measured layout, in document coordinates.
 *
 * @param {{
 *   currentScrollY: number,
 *   blockTop: number,
 *   blockBottom: number,
 *   visibleHeight: number,
 *   reserve: number,
 *   maxScroll: number,
 * }} layout
 * @returns {number} the target window.scrollY
 */
export function pageRevealTarget(layout) {
  const {
    currentScrollY,
    blockTop,
    blockBottom,
    visibleHeight,
    reserve,
    maxScroll,
  } = layout;
  const usable = visibleHeight - reserve;
  const target =
    blockBottom - blockTop <= usable
      ? blockBottom + reserve - visibleHeight
      : blockTop;
  if (target <= currentScrollY) return currentScrollY;
  return Math.min(target, maxScroll);
}

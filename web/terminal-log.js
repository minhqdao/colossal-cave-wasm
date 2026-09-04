// @ts-check

// Pure decision helpers for the transcript log driver, distilled from the
// keyboard-lab blue29/30/31 builds (blue31.html is the accepted build).
// blue29's answer to the transcript rubber band is to stop giving the log
// native scroll physics at all: #screen is overflow:hidden -- a
// non-scroller cannot stretch, cannot chain, and has no overscroll
// behavior to be overruled mid-gesture (blue26-28 shipped the evidence
// that WebKit decides a gesture's overscroll up front, so CSS at the edge
// cannot help a drag that ARRIVES there). All log movement is driven by
// the launcher's touch/wheel handlers writing scrollTop, clamped to
// [0, room] and rounded to whole pixels on every write -- the ends are
// hard BY CONSTRUCTION. What can be decided from numbers alone lives
// here so it can be unit-tested without a browser.
//
// The contract both input paths share: the log has priority while it has
// anywhere to go, and the page (default behavior, pull-to-refresh) takes
// over only once the log is spent. A gesture's owner -- log or page -- is
// settled once and never re-settled, because a browser will not reliably
// hand a gesture back mid-flight (see decideLogOwner).

/**
 * How far the finger must travel before the driver claims a gesture, px.
 * Below this the gesture is nobody's yet: the browser's own touch slop
 * (~8px on Android, ~10px on iOS) has not been crossed either, so no
 * native scroll has started and nothing is foreclosed. Claiming UNDER the
 * browser's slop is the point -- the driver latches the gesture before the
 * browser can.
 */
export const GESTURE_SLOP_PX = 6;

/** Momentum cap, px per 16.667ms frame. */
export const FLICK_MAX_VELOCITY = 48;

/** A slower release is a drag end, not a flick. */
export const FLICK_MIN_START_VELOCITY = 0.8;

/** Momentum dies once decayed below this, px per frame. */
export const FLICK_STOP_VELOCITY = 0.4;

/** Momentum decay per 16.667ms frame. */
export const FLICK_DECAY = 0.88;

/** Largest per-frame dt the decay accounts for, ms. */
export const FLICK_MAX_DT_MS = 48;

/**
 * Who owns one touch gesture over the transcript. The owner is decided
 * ONCE, from the log's state at touchstart and the direction the finger
 * first commits to, and then never re-decided: "log" means the driver
 * preventDefaults every move of the gesture and writes the clamped
 * scrollTop; "page" means the driver never touches it and the browser
 * runs its own default (pull-to-refresh, at the top of the document).
 *
 * Deciding once is the whole fix (blue32). The previous per-move
 * classifier handed a gesture to the page the moment the log reached its
 * top mid-drag, which assumes the browser is still willing to take it --
 * true on iOS, where WebKit locks a touch to its first scroll owner, but
 * not on Android: Blink latches the gesture to the document scroller the
 * instant one touchmove is not preventDefault-ed, and once latched the
 * rest of the gesture arrives with cancelable = false, so preventDefault
 * is a no-op. A drag that started deep in the log then scrolled the
 * transcript AND pulled the page's refresh at the same time -- you could
 * not drag the transcript down without actuating pull-to-refresh. Worse,
 * whether the first move was still cancelable varied with the log's
 * scroll offset, so the same drag misbehaved only sometimes.
 *
 * "undecided" is the move still inside the slop: the direction is not
 * known, and nothing has moved, so the driver stands aside without
 * foreclosing the page.
 *
 * @param {{
 *   dy: number,
 *   top0: number,
 *   room: number,
 *   selectionCollapsed: boolean,
 *   slopPx?: number,
 * }} s
 * @returns {"log" | "page" | "undecided"}
 */
export function decideLogOwner({
  dy,
  top0,
  room,
  selectionCollapsed,
  slopPx = GESTURE_SLOP_PX,
}) {
  if (room <= 1) return "page"; // nothing to scroll: not ours at all
  if (!selectionCollapsed) return "page"; // a selection drag, not a scroll
  if (Math.abs(dy) < slopPx) return "undecided";
  // South (finger down, reading back): ours while there is transcript
  // above the viewport. Parked at the top it is nobody's scroll, so the
  // document's own pull-to-refresh runs, from the first pixel.
  if (dy > 0) return top0 > 0 ? "log" : "page";
  // North (finger up, reading forward): ours while there is transcript
  // below. Parked at the end, the page owns it.
  return top0 < room ? "log" : "page";
}

/**
 * Release velocity for the emulated flick, px per 16.667ms frame, from
 * the driven scrollTop samples (kept: at most the last four). Native
 * momentum needs a scroller and the log has none, so the flick is
 * emulated from the last two samples. Returns 0 when there is nothing to
 * launch from (too few samples, a zero dt, or a release too slow to be a
 * flick).
 *
 * @param {Array<{ t: number, st: number }>} samples ascending in time
 * @param {{ cap?: number, min?: number }} [opts]
 * @returns {number}
 */
export function flickVelocity(
  samples,
  { cap = FLICK_MAX_VELOCITY, min = FLICK_MIN_START_VELOCITY } = {},
) {
  if (samples.length < 2) return 0;
  const a = samples[samples.length - 2];
  const b = samples[samples.length - 1];
  const dt = b.t - a.t;
  if (dt <= 0) return 0;
  const raw = ((b.st - a.st) / dt) * 16.667;
  const clamped = Math.max(-cap, Math.min(cap, raw));
  return Math.abs(clamped) < min ? 0 : clamped;
}

/**
 * One frame of the emulated momentum. Reads the CURRENT scrollTop (game
 * output may have re-pinned the log mid-flight), decays the velocity,
 * integrates, and stops hard: at either end the log cannot leave its
 * range -- there is no code path in which it does -- and below the stop
 * velocity the flick is over. The written scrollTop is a whole pixel:
 * subpixel writes shimmered the last few px before a stop (blue30).
 *
 * @param {{
 *   scrollTop: number,
 *   velocity: number,
 *   dtMs: number,
 *   room: number,
 *   decay?: number,
 *   stop?: number,
 *   maxDtMs?: number,
 * }} s
 * @returns {{ scrollTop: number, velocity: number, running: boolean }}
 */
export function momentumStep({
  scrollTop,
  velocity,
  dtMs,
  room,
  decay = FLICK_DECAY,
  stop = FLICK_STOP_VELOCITY,
  maxDtMs = FLICK_MAX_DT_MS,
}) {
  const dtFrames = Math.min(maxDtMs, Math.max(0, dtMs)) / 16.667;
  const v = velocity * Math.pow(decay, dtFrames);
  let st = scrollTop + v * dtFrames;
  let dead = false;
  if (st >= room) {
    st = room; // hard stop: the end
    dead = true;
  } else if (st <= 0) {
    st = 0; // hard stop: the top
    dead = true;
  } else if (Math.abs(v) < stop) {
    dead = true;
  }
  return { scrollTop: Math.round(st), velocity: dead ? 0 : v, running: !dead };
}

/**
 * The clamped, whole-pixel scrollTop a driven move writes. The ends are
 * hard by construction: no clamping bug anywhere in the gesture path can
 * push the text out of its range.
 *
 * @param {{ top0: number, dy: number, room: number }} s
 * @returns {number}
 */
export function drivenScrollTop({ top0, dy, room }) {
  return Math.round(Math.max(0, Math.min(room, top0 - dy)));
}

/** Wheel line-mode delta in CSS px per notch (deltaMode 1). */
export const WHEEL_LINE_PX = 16;

/**
 * One wheel event's effect on the log, and whether the event must be
 * preventDefault-ed. The log has priority while it has anywhere to go: a
 * delta that merely REACHES an end is consumed whole (the log clamps, the
 * surplus is dropped) and the page stays put. Only once the log is
 * ALREADY parked at the edge it is being pushed against is the event left
 * alone for the browser to scroll the page with.
 *
 * blue31 chained on the overshoot instead -- "the delta did not fit, so
 * let the page have it" -- which meant the page started scrolling the
 * moment the log came within one delta of its end. On a trackpad that is
 * most of a single swipe, so scrolling the transcript also walked the
 * whole page out from under it and left it there: the log and the page
 * moved together, and reversing the wheel moved only the log while the
 * page stayed offset. Splitting the surplus properly is not available
 * either: it needs a programmatic page scroll inside the handler, which
 * fights the scrolling thread and wiggles harder (blue31's own note).
 * Dropping the surplus costs one extra notch before the page takes over
 * and buys a page that never moves while the log still can.
 *
 * Line/page delta modes are converted to pixels (page-mode needs the page
 * height) so the decision is in one unit. The returned scrollTop is a
 * whole pixel, like every other write into the log.
 *
 * @param {{
 *   deltaY: number,
 *   deltaMode?: number,
 *   scrollTop: number,
 *   room: number,
 *   pageHeight?: number,
 * }} s
 * @returns {{ scrollTop: number, prevent: boolean }}
 */
export function decideLogWheel({
  deltaY,
  deltaMode = 0,
  scrollTop,
  room,
  pageHeight = 0,
}) {
  const dy =
    deltaMode === 1
      ? deltaY * WHEEL_LINE_PX
      : deltaMode === 2
        ? deltaY * pageHeight
        : deltaY;
  // The page gets it only when the log was spent BEFORE this event.
  const spent =
    room <= 1 ||
    (dy > 0 && scrollTop >= room) ||
    (dy < 0 && scrollTop <= 0);
  return {
    scrollTop: Math.round(Math.max(0, Math.min(room, scrollTop + dy))),
    prevent: !spent,
  };
}

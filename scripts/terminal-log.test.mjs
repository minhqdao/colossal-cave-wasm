// Unit tests for the pure helpers in web/terminal-log.js -- the transcript
// driver distilled from keyboard-lab/blue30/31. These need no DOM: the move
// classifier, the wheel decision, the flick velocity, and the momentum step
// take plain numbers so the log's contract can be driven deterministically:
//
//   - a gesture's owner is settled ONCE, from the log's state at
//     touchstart and the direction the finger commits to, and then held:
//     the log keeps a gesture until it runs out of transcript, the page
//     gets the ones the log cannot use (blue32's fix for the Android
//     drag that actuated pull-to-refresh while also scrolling the log);
//   - everything the log drives is clamped to [0, room] and rounded to
//     whole pixels, so the ends are hard by construction (no rubber band,
//     from a drag, a flick, or a wheel, from any starting position);
//   - a wheel is consumed while the log has anywhere left to go, and
//     reaches the page only once the log is ALREADY parked at the edge it
//     is being pushed against (blue32; blue31 chained on the overshoot).
//
//   node --test scripts/terminal-log.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  FLICK_DECAY,
  FLICK_MAX_VELOCITY,
  GESTURE_SLOP_PX,
  WHEEL_LINE_PX,
  decideLogOwner,
  decideLogWheel,
  drivenScrollTop,
  flickVelocity,
  momentumStep,
} from "../web/terminal-log.js";

/** A southward pull that started mid-log, with room above it. */
const PULL = { dy: 100, top0: 200, room: 400, selectionCollapsed: true };

test("decideLogOwner: an ordinary mid-log drag belongs to the log, either way", () => {
  // South: reading back, there is transcript above.
  assert.equal(decideLogOwner({ ...PULL }), "log");
  // North: reading forward, there is transcript below.
  assert.equal(decideLogOwner({ ...PULL, dy: -100 }), "log");
});

test("decideLogOwner: the log keeps a gesture it is about to run out of", () => {
  // blue32: a pull that will reach the top mid-gesture still belongs to
  // the log. Handing it to the page there is what let Blink latch the
  // gesture to the document and run pull-to-refresh against a log that
  // was still scrolling.
  assert.equal(decideLogOwner({ dy: 100, top0: 50, room: 400, selectionCollapsed: true }), "log");
  // Even a single move that would overshoot the top by a mile: the log
  // clamps it and keeps the gesture.
  assert.equal(decideLogOwner({ dy: 500, top0: 300, room: 400, selectionCollapsed: true }), "log");
  // Same at the other end.
  assert.equal(decideLogOwner({ dy: -500, top0: 100, room: 400, selectionCollapsed: true }), "log");
});

test("decideLogOwner: a log parked at the edge hands that direction to the page", () => {
  // At the top, pulling south is nobody's scroll: the browser's own
  // pull-to-refresh runs, from the first decisive pixel.
  assert.equal(decideLogOwner({ dy: 100, top0: 0, room: 400, selectionCollapsed: true }), "page");
  // At the end, pushing north has nothing left to show.
  assert.equal(decideLogOwner({ dy: -100, top0: 400, room: 400, selectionCollapsed: true }), "page");
  // Parked at one edge only blocks the direction it is spent in: from the
  // top you can still read forward, from the end you can still read back.
  assert.equal(decideLogOwner({ dy: -100, top0: 0, room: 400, selectionCollapsed: true }), "log");
  assert.equal(decideLogOwner({ dy: 100, top0: 400, room: 400, selectionCollapsed: true }), "log");
});

test("decideLogOwner: a move inside the slop decides nothing", () => {
  // The direction is not known yet, and nothing has moved, so the driver
  // stands aside -- and does not foreclose the page's pull-to-refresh by
  // preventDefault-ing a tremor.
  for (const dy of [0, 1, -1, GESTURE_SLOP_PX - 1, -(GESTURE_SLOP_PX - 1)]) {
    assert.equal(decideLogOwner({ ...PULL, dy }), "undecided", `dy=${dy}`);
  }
  // The first move past the slop is the one that decides.
  assert.equal(decideLogOwner({ ...PULL, dy: GESTURE_SLOP_PX }), "log");
  assert.equal(decideLogOwner({ ...PULL, dy: -GESTURE_SLOP_PX }), "log");
});

test("decideLogOwner: a short log is the page's", () => {
  // Nothing to scroll: the driver stands aside entirely.
  assert.equal(decideLogOwner({ ...PULL, room: 1 }), "page");
  assert.equal(decideLogOwner({ dy: -40, top0: 0, room: 0, selectionCollapsed: true }), "page");
});

test("decideLogOwner: a selection drag is not a scroll", () => {
  assert.equal(decideLogOwner({ ...PULL, selectionCollapsed: false }), "page");
});

test("drivenScrollTop: clamped to [0, room] and whole-pixel", () => {
  assert.equal(drivenScrollTop({ top0: 200, dy: 50, room: 400 }), 150);
  assert.equal(drivenScrollTop({ top0: 30, dy: 300, room: 400 }), 0, "top is hard");
  assert.equal(drivenScrollTop({ top0: 390, dy: -300, room: 400 }), 400, "end is hard");
  // Fractional clientY (iOS) must never write a fractional scrollTop:
  // subpixel writes shimmered the last few px before a stop (blue30).
  assert.equal(
    Number.isInteger(drivenScrollTop({ top0: 10, dy: -10.37, room: 400 })),
    true,
  );
  assert.equal(drivenScrollTop({ top0: 10, dy: -10.37, room: 400 }), 20);
});

// --- the wheel (blue32: consumed until the log is spent) --------------------
test("decideLogWheel: a delta that fits inside the log is consumed", () => {
  assert.deepEqual(
    decideLogWheel({ deltaY: 50, scrollTop: 100, room: 400 }),
    { scrollTop: 150, prevent: true },
  );
  // Exactly onto an end still fits: consumed, no page scroll.
  assert.deepEqual(
    decideLogWheel({ deltaY: 10, scrollTop: 390, room: 400 }),
    { scrollTop: 400, prevent: true },
  );
  assert.deepEqual(
    decideLogWheel({ deltaY: -5, scrollTop: 5, room: 400 }),
    { scrollTop: 0, prevent: true },
  );
});

test("decideLogWheel: a delta that REACHES an end is consumed whole", () => {
  // blue32: the surplus is dropped, not chained. blue31 handed the event
  // to the page here, which started the page the moment the log came
  // within one delta of its end -- on a trackpad that is most of a swipe,
  // so scrolling the transcript shifted the whole layout with it.
  assert.deepEqual(
    decideLogWheel({ deltaY: 30, scrollTop: 390, room: 400 }),
    { scrollTop: 400, prevent: true },
  );
  // Same at the top, scrolling back up.
  assert.deepEqual(
    decideLogWheel({ deltaY: -30, scrollTop: 5, room: 400 }),
    { scrollTop: 0, prevent: true },
  );
  // A delta orders of magnitude bigger than the room is still the log's.
  assert.deepEqual(
    decideLogWheel({ deltaY: 900, scrollTop: 10, room: 400 }),
    { scrollTop: 400, prevent: true },
  );
});

test("decideLogWheel: a log parked at the edge hands the wheel to the page", () => {
  // The log was spent BEFORE this event, so the page can have it.
  assert.deepEqual(
    decideLogWheel({ deltaY: 30, scrollTop: 400, room: 400 }),
    { scrollTop: 400, prevent: false },
  );
  assert.deepEqual(
    decideLogWheel({ deltaY: -30, scrollTop: 0, room: 400 }),
    { scrollTop: 0, prevent: false },
  );
  // Parked at one edge only spends that direction.
  assert.deepEqual(
    decideLogWheel({ deltaY: -30, scrollTop: 400, room: 400 }),
    { scrollTop: 370, prevent: true },
  );
  assert.deepEqual(
    decideLogWheel({ deltaY: 30, scrollTop: 0, room: 400 }),
    { scrollTop: 30, prevent: true },
  );
});

test("decideLogWheel: a short log chains every wheel to the page", () => {
  // room 0/1 leaves no delta to consume; the caller already stood aside
  // for room <= 1, and the helper's clamp is a hard edge either way.
  assert.deepEqual(
    decideLogWheel({ deltaY: -40, scrollTop: 0, room: 0 }),
    { scrollTop: 0, prevent: false },
  );
  assert.deepEqual(
    decideLogWheel({ deltaY: 40, scrollTop: 1, room: 1 }),
    { scrollTop: 1, prevent: false },
  );
});

test("decideLogWheel: line-mode deltas are converted to pixels", () => {
  // deltaMode 1 (classic mouse notches): one notch = 16 CSS px.
  assert.deepEqual(
    decideLogWheel({ deltaY: 3, deltaMode: 1, scrollTop: 50, room: 400 }),
    { scrollTop: 50 + 3 * WHEEL_LINE_PX, prevent: true },
  );
  // The conversion decides where the log lands, not the raw notch count:
  // 30 lines is 480px, which is past the top and clamps the log there.
  assert.deepEqual(
    decideLogWheel({ deltaY: -30, deltaMode: 1, scrollTop: 10, room: 400 }),
    { scrollTop: 0, prevent: true },
  );
  // A notch that cannot move the log at all (already parked) is the
  // page's, exactly like a pixel delta.
  assert.deepEqual(
    decideLogWheel({ deltaY: -1, deltaMode: 1, scrollTop: 0, room: 400 }),
    { scrollTop: 0, prevent: false },
  );
});

test("decideLogWheel: page-mode deltas are converted to pixels", () => {
  // deltaMode 2 (Page Down/Up): one page = the viewport height. A page
  // swallows the whole log, so it is consumed and the page stays put.
  assert.deepEqual(
    decideLogWheel({ deltaY: 1, deltaMode: 2, scrollTop: 300, room: 800, pageHeight: 844 }),
    { scrollTop: 800, prevent: true },
  );
  assert.deepEqual(
    decideLogWheel({ deltaY: -1, deltaMode: 2, scrollTop: 100, room: 800, pageHeight: 844 }),
    { scrollTop: 0, prevent: true },
  );
});

test("decideLogWheel: every written scrollTop is a whole pixel", () => {
  // Fractional trackpad deltas (Safari) must never write a fractional
  // scrollTop: the shimmer fix applies to the wheel path too (blue30).
  for (const dy of [0.5, -10.37, 8.9]) {
    const st = decideLogWheel({ deltaY: dy, scrollTop: 10, room: 400 });
    assert.equal(Number.isInteger(st.scrollTop), true, `deltaY=${dy}`);
  }
  assert.deepEqual(
    decideLogWheel({ deltaY: 10.5, scrollTop: 100, room: 400 }),
    { scrollTop: 111, prevent: true },
  );
});

/** @param {number[]} sts driven scrollTop samples, 16.667ms apart (one frame) */
function samples(sts) {
  return sts.map((st, i) => ({ t: i * 16.667, st }));
}

test("flickVelocity: converts px/ms to px per 16.667ms frame", () => {
  // 1px/ms * 16.667 = 16.667 px/frame.
  const v = flickVelocity(samples([100, 116.667]));
  assert.ok(Math.abs(v - 16.667) < 1e-9, `got ${v}`);
});

test("flickVelocity: clamps to the cap in both directions", () => {
  assert.equal(flickVelocity(samples([0, 500])), FLICK_MAX_VELOCITY);
  assert.equal(flickVelocity(samples([500, 0])), -FLICK_MAX_VELOCITY);
});

test("flickVelocity: a slow release is not a flick", () => {
  assert.equal(flickVelocity(samples([100, 100.5])), 0);
});

test("flickVelocity: nothing to launch from", () => {
  assert.equal(flickVelocity([]), 0);
  assert.equal(flickVelocity([{ t: 0, st: 10 }]), 0);
  // Two samples with the same timestamp: no dt, no velocity.
  assert.equal(flickVelocity([{ t: 5, st: 10 }, { t: 5, st: 40 }]), 0);
});

test("momentumStep: decays one frame at 16.667ms by the decay factor", () => {
  const s = momentumStep({ scrollTop: 100, velocity: 10, dtMs: 16.667, room: 400 });
  assert.ok(Math.abs(s.velocity - 10 * FLICK_DECAY) < 1e-9, `got ${s.velocity}`);
  // scrollTop = 100 + 8.8 * 1 frame.
  assert.ok(Math.abs(s.scrollTop - Math.round(108.8)) < 1, `got ${s.scrollTop}`);
  assert.equal(s.running, true);
});

test("momentumStep: clamps long frames so a stutter cannot jump", () => {
  // 500ms since the last frame: the decay and integration use 48ms.
  const clamped = momentumStep({ scrollTop: 100, velocity: 10, dtMs: 500, room: 400 });
  const at48 = momentumStep({ scrollTop: 100, velocity: 10, dtMs: 48, room: 400 });
  assert.equal(clamped.scrollTop, at48.scrollTop);
});

test("momentumStep: hard stop at the top", () => {
  const s = momentumStep({ scrollTop: 2, velocity: -30, dtMs: 16.667, room: 400 });
  assert.equal(s.scrollTop, 0);
  assert.equal(s.velocity, 0);
  assert.equal(s.running, false);
});

test("momentumStep: hard stop at the end", () => {
  const s = momentumStep({ scrollTop: 395, velocity: 30, dtMs: 16.667, room: 400 });
  assert.equal(s.scrollTop, 400);
  assert.equal(s.velocity, 0);
  assert.equal(s.running, false);
});

test("momentumStep: dies below the stop velocity", () => {
  const s = momentumStep({ scrollTop: 100, velocity: 0.3, dtMs: 16.667, room: 400 });
  assert.equal(s.running, false);
  assert.equal(s.velocity, 0);
});

test("momentumStep: a flick near the end lands exactly on it", () => {
  // A capped flick covers ~350px; from 60 it crosses the end, which must
  // clamp it exactly, never past.
  let st = 60;
  let vel = FLICK_MAX_VELOCITY;
  let frames = 0;
  while (frames++ < 200) {
    const s = momentumStep({ scrollTop: st, velocity: vel, dtMs: 16.667, room: 400 });
    st = s.scrollTop;
    vel = s.velocity;
    assert.ok(st >= 0 && st <= 400, `scrollTop left its range: ${st}`);
    if (!s.running) break;
  }
  assert.equal(st, 400, "the flick must end exactly at the hard end");
});

test("momentumStep: a flick that dies mid-log stays in range", () => {
  // In a long log the same flick decays below the stop velocity before
  // reaching either end: it must simply stop, wherever that is, inside
  // the range -- there is no code path in which the log leaves it.
  let st = 400;
  let vel = FLICK_MAX_VELOCITY;
  let frames = 0;
  while (frames++ < 200) {
    const s = momentumStep({ scrollTop: st, velocity: vel, dtMs: 16.667, room: 800 });
    st = s.scrollTop;
    vel = s.velocity;
    assert.ok(st >= 0 && st <= 800, `scrollTop left its range: ${st}`);
    if (!s.running) break;
  }
  assert.ok(st > 400 && st < 800, `a mid-log death must stay mid-log: ${st}`);
});

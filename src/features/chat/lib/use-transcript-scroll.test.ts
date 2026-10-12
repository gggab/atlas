// @vitest-environment happy-dom
//
// The scroll loop must not learn anything from a HIDDEN scroller. A chat tab
// that stays mounted while another tab is showing can be `display:none` (a
// background project), and a `display:none` scroller reports 0×0 with
// `scrollTop` 0. Fed to `sample()` that reads as "at the end, and at the very
// top": the at-end flag latched, so a reader who had scrolled up in a
// background streaming tab was snapped to the bottom on return, and the grow
// trigger fired a prepend into a panel nobody was looking at.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTranscriptScroll } from "./use-transcript-scroll";

const windowFocus = vi.hoisted(() => ({ listeners: new Set<(focused: boolean) => void>() }));
vi.mock("@/lib/window-focus", () => ({
  onWindowFocusChange: (cb: (focused: boolean) => void) => {
    windowFocus.listeners.add(cb);
    return () => windowFocus.listeners.delete(cb);
  },
}));

let resizeCallbacks: ResizeObserverCallback[] = [];
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  resizeCallbacks = [];
  frames = [];
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Queued, NOT synchronous: `frame.current = requestAnimationFrame(sample)`
  // would otherwise run `sample` (which nulls the ref) before the assignment
  // lands, latching "a frame is pending" for the rest of the test.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Geometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

function setGeometry(el: HTMLElement, g: Geometry): void {
  let top = g.scrollTop;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
}

function fireResize(): void {
  for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
}

function flushFrames(): void {
  const queued = frames.splice(0);
  for (const cb of queued) cb(0);
}

const VISIBLE: Geometry = { scrollHeight: 5000, clientHeight: 600, scrollTop: 3000 };
const HIDDEN: Geometry = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };

describe("useTranscriptScroll window restoration", () => {
  it.each([4400, 3000])(
    "restores scrollTop %i after hiding and receiving background messages",
    (top) => {
      const scroller = document.createElement("div");
      const content = document.createElement("div");
      setGeometry(scroller, { ...VISIBLE, scrollTop: top });
      const onGrow = vi.fn();
      const onContentResize = vi.fn();
      const { result } = renderHook(() =>
        useTranscriptScroll({
          scrollRef: { current: scroller },
          contentRef: { current: content },
          canGrow: true,
          onGrow,
          onContentResize,
        }),
      );
      act(flushFrames);
      onContentResize.mockClear();

      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      // Some webviews retain nonzero geometry while minimized but reset the offset.
      setGeometry(scroller, { scrollHeight: 6000, clientHeight: 600, scrollTop: 0 });
      act(() => {
        fireResize();
        result.current.onScroll();
        flushFrames();
      });
      expect(result.current.atEndRef.current).toBe(top === 4400);
      expect(onGrow).not.toHaveBeenCalled();
      expect(onContentResize).not.toHaveBeenCalled();

      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        flushFrames();
      });
      expect(scroller.scrollTop).toBe(top === 4400 ? 5400 : top);
      expect(result.current.more).toBe(top !== 4400);
      expect(onGrow).not.toHaveBeenCalled();
    },
  );

  it("restores the live edge after a collapsed viewport without a visibility event", () => {
    const scroller = document.createElement("div");
    setGeometry(scroller, { ...VISIBLE, scrollTop: 4400 });
    const onGrow = vi.fn();
    renderHook(() =>
      useTranscriptScroll({
        scrollRef: { current: scroller },
        contentRef: { current: document.createElement("div") },
        canGrow: true,
        onGrow,
      }),
    );
    act(flushFrames);
    setGeometry(scroller, HIDDEN);
    // Animation frames can stop while minimized; the observer still saw zero.
    act(fireResize);
    setGeometry(scroller, { ...VISIBLE, scrollTop: 0 });
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(scroller.scrollTop).toBe(4400);
    expect(onGrow).not.toHaveBeenCalled();
  });

  it.each([4400, 3000])("restores scrollTop %i on native wake without web events", (top) => {
    const scroller = document.createElement("div");
    setGeometry(scroller, { ...VISIBLE, scrollTop: top });
    const onGrow = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTranscriptScroll({
        scrollRef: { current: scroller },
        contentRef: { current: document.createElement("div") },
        canGrow: true,
        onGrow,
      }),
    );
    act(flushFrames);
    act(() => {
      for (const cb of windowFocus.listeners) cb(false);
    });
    setGeometry(scroller, { ...VISIBLE, scrollTop: 0 });
    act(() => {
      result.current.onScroll();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(top === 4400);
    expect(onGrow).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new CustomEvent("atlas:window-active"));
      flushFrames();
    });
    expect(scroller.scrollTop).toBe(top);
    unmount();
    expect(windowFocus.listeners.size).toBe(0);
  });
});

describe("useTranscriptScroll hidden-panel guard", () => {
  it("ignores a 0×0 sample and re-measures once the panel is visible again", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    setGeometry(scroller, VISIBLE);
    const onGrow = vi.fn();

    const { result } = renderHook(() =>
      useTranscriptScroll({
        scrollRef: { current: scroller },
        contentRef: { current: content },
        canGrow: true,
        onGrow,
      }),
    );

    // Visible, scrolled up into history: not at the end, more below.
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(false);
    expect(result.current.more).toBe(true);
    expect(onGrow).not.toHaveBeenCalled();

    // Hidden: the observer fires with everything at zero. Nothing may change.
    setGeometry(scroller, HIDDEN);
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(false);
    expect(result.current.more).toBe(true);
    expect(onGrow).not.toHaveBeenCalled();

    // Shown again with the same geometry: still where the reader left it.
    setGeometry(scroller, VISIBLE);
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(false);
    expect(result.current.more).toBe(true);
    expect(onGrow).not.toHaveBeenCalled();

    // A real scroll to the bottom is still seen — the guard only skips the
    // hidden sample, it does not stick the cached geometry.
    setGeometry(scroller, { ...VISIBLE, scrollTop: 4400 });
    act(() => {
      result.current.onScroll();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(true);
    expect(result.current.more).toBe(false);
  });

  it("does not grow the window from a hidden panel's scrollTop of 0", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    setGeometry(scroller, HIDDEN);
    const onGrow = vi.fn();
    const onBeforeGrow = vi.fn();

    renderHook(() =>
      useTranscriptScroll({
        scrollRef: { current: scroller },
        contentRef: { current: content },
        canGrow: true,
        onGrow,
        onBeforeGrow,
      }),
    );
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(onBeforeGrow).not.toHaveBeenCalled();
    expect(onGrow).not.toHaveBeenCalled();

    // Visible near the top → the normal grow path still works.
    setGeometry(scroller, { scrollHeight: 5000, clientHeight: 600, scrollTop: 100 });
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(onBeforeGrow).toHaveBeenCalledTimes(1);
    expect(onGrow).toHaveBeenCalledTimes(1);
  });
});

// The `visibility:hidden` sibling of the guard above. A hidden chat tab keeps
// its layout, so its geometry is REAL and passes every sanity check the 0×0
// guard makes — the only thing that knows it should be ignored is the caller.
describe("useTranscriptScroll visible gate", () => {
  it("changes nothing while hidden, and re-measures on the way back", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    setGeometry(scroller, VISIBLE);
    const onGrow = vi.fn();

    const { result, rerender } = renderHook(
      ({ visible }: { visible: boolean }) =>
        useTranscriptScroll({
          scrollRef: { current: scroller },
          contentRef: { current: content },
          canGrow: true,
          onGrow,
          visible,
        }),
      { initialProps: { visible: true } },
    );

    act(() => {
      fireResize();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(false);
    expect(result.current.more).toBe(true);

    // Hidden, and something behind the scenes scrolls it to the bottom — a
    // live-edge follow that slipped through, say. The reader's position is
    // what must survive, so nothing here may be believed.
    rerender({ visible: false });
    setGeometry(scroller, { ...VISIBLE, scrollTop: 4400 });
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(false);
    expect(result.current.more).toBe(true);

    // Back in view: the geometry left dirty while hidden is re-read without
    // anyone having to scroll.
    rerender({ visible: true });
    act(() => {
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(true);
    expect(result.current.more).toBe(false);
  });

  it("never grows a hidden window, however close to the top it sits", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    // Well inside GROW_MARGIN: visible, this grows on the first sample.
    setGeometry(scroller, { scrollHeight: 5000, clientHeight: 600, scrollTop: 100 });
    const onGrow = vi.fn();
    const onBeforeGrow = vi.fn();

    const { rerender } = renderHook(
      ({ visible }: { visible: boolean }) =>
        useTranscriptScroll({
          scrollRef: { current: scroller },
          contentRef: { current: content },
          canGrow: true,
          onGrow,
          onBeforeGrow,
          visible,
        }),
      { initialProps: { visible: false } },
    );

    act(() => {
      fireResize();
      flushFrames();
    });
    expect(onGrow).not.toHaveBeenCalled();
    expect(onBeforeGrow).not.toHaveBeenCalled();

    rerender({ visible: true });
    act(() => {
      flushFrames();
    });
    expect(onGrow).toHaveBeenCalledTimes(1);
  });
});

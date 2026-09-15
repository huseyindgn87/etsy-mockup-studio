// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BURST_DURATION_MS, burstDollars } from "../dollar-burst";

let animateMock: ReturnType<typeof vi.fn>;

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion: reduce"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function layers() {
  return document.body.querySelectorAll("[data-dollar-burst]");
}

/** Parses the `translate(dx, dy)` pair out of a keyframe transform. */
function offsetOf(frame: Keyframe): { dx: number; dy: number } {
  const m = String(frame.transform).match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
  if (!m) throw new Error(`no offset in ${String(frame.transform)}`);
  return { dx: Number(m[1]), dy: Number(m[2]) };
}

beforeEach(() => {
  // jsdom has no Web Animations API; stand one in so the keyframes can be inspected.
  animateMock = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animateMock, configurable: true, writable: true });
  stubReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

describe("burstDollars", () => {
  test("launches 20–30 \"$\" particles from the click point", () => {
    const layer = burstDollars(120, 80)!;
    expect(layer).not.toBeNull();
    expect(layer.parentElement).toBe(document.body);

    const particles = [...layer.children] as HTMLElement[];
    expect(particles.length).toBeGreaterThanOrEqual(20);
    expect(particles.length).toBeLessThanOrEqual(30);
    for (const p of particles) {
      expect(p.textContent).toBe("$");
      expect(p.style.left).toBe("120px");
      expect(p.style.top).toBe("80px");
    }
  });

  test("particle count spans exactly 20 to 30", () => {
    expect(burstDollars(0, 0, () => 0)!.children).toHaveLength(20);
    expect(burstDollars(0, 0, () => 0.9999)!.children).toHaveLength(30);
  });

  test("never intercepts pointer input — layer and every particle are pointer-events: none", () => {
    const layer = burstDollars(10, 10)!;
    expect(layer.style.pointerEvents).toBe("none");
    expect(layer.style.position).toBe("fixed");
    expect(layer).toHaveAttribute("aria-hidden", "true");
    for (const p of layer.children) expect((p as HTMLElement).style.pointerEvents).toBe("none");
  });

  test("each particle bursts outward and upward, falls under gravity, and fades out in about a second", () => {
    const layer = burstDollars(200, 200)!;
    expect(animateMock).toHaveBeenCalledTimes(layer.children.length);

    const horizontal = new Set<number>();
    for (const [frames, options] of animateMock.mock.calls as [Keyframe[], KeyframeAnimationOptions][]) {
      expect(options.duration).toBeGreaterThanOrEqual(0.85 * BURST_DURATION_MS);
      expect(options.duration).toBeLessThanOrEqual(BURST_DURATION_MS);

      expect(frames[0].opacity).toBe(1);
      expect(frames.at(-1)!.opacity).toBe(0);

      // Starts at the click point, first moves up...
      expect(offsetOf(frames[0])).toEqual({ dx: 0, dy: 0 });
      expect(offsetOf(frames[1]).dy).toBeLessThan(0);

      // ...then gravity: the vertical step between frames keeps growing downward.
      const dys = frames.map((f) => offsetOf(f).dy);
      const steps = dys.slice(1).map((dy, i) => dy - dys[i]);
      for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);

      horizontal.add(Math.sign(offsetOf(frames.at(-1)!).dx));
    }
    // Spreads to both sides, like a firework.
    expect(horizontal.has(1) && horizontal.has(-1)).toBe(true);
  });

  test("stays a tight burst close to the click point", () => {
    // Fastest launch at the widest angle, the opposite extreme, and a random one.
    burstDollars(200, 200, () => 0.9999);
    burstDollars(200, 200, () => 0);
    burstDollars(200, 200);

    let furthest = 0;
    for (const [frames] of animateMock.mock.calls as [Keyframe[]][]) {
      for (const f of frames) {
        const { dx, dy } = offsetOf(f);
        furthest = Math.max(furthest, Math.hypot(dx, dy));
      }
    }
    // The original tuning reached ~760px at the extremes; a third of that is ~255px.
    expect(furthest).toBeLessThanOrEqual(270);
    expect(furthest).toBeGreaterThan(50); // still visibly bursts
  });

  test("cleans itself up after the effect", () => {
    vi.useFakeTimers();
    burstDollars(10, 10);
    expect(layers()).toHaveLength(1);

    vi.advanceTimersByTime(BURST_DURATION_MS);
    expect(layers()).toHaveLength(1);

    vi.advanceTimersByTime(200);
    expect(layers()).toHaveLength(0);
  });

  test("with prefers-reduced-motion: reduce, does nothing at all", () => {
    stubReducedMotion(true);
    expect(burstDollars(10, 10)).toBeNull();
    expect(layers()).toHaveLength(0);
    expect(animateMock).not.toHaveBeenCalled();
  });
});

/**
 * A one-shot firework of "$" particles from a point on screen — played when a
 * shop button is clicked. Plain DOM + the Web Animations API, no library.
 *
 * The particles live in a fixed, full-viewport layer appended to
 * `document.body` (not inside the React tree), so they keep playing while the
 * click's client-side navigation swaps the page underneath. The layer and
 * every particle are `pointer-events: none`, and nothing here calls
 * `preventDefault`, so the click and its navigation are never blocked.
 * Skipped entirely under `prefers-reduced-motion: reduce`.
 */

const MIN_PARTICLES = 20;
const MAX_PARTICLES = 30;
/** Total lifetime of the effect; each particle lasts 85–100% of this. */
export const BURST_DURATION_MS = 1000;
/**
 * px/s² — pulls particles back down after the upward launch. Scaled together
 * with the launch speed below (both a third of their original 1200 / 300–650)
 * so every trajectory keeps its shape but covers a third of the distance — a
 * tight burst around the click point.
 */
const GRAVITY = 400;
const KEYFRAME_SAMPLES = 16;
const COLORS = ["var(--color-primary)", "var(--color-accent)", "#d4a017", "#2f9e44"];

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Launches the burst from viewport coordinates `(x, y)`. Returns the layer
 * element (removed automatically after the effect), or `null` when skipped.
 * `random` is injectable for tests.
 */
export function burstDollars(x: number, y: number, random: () => number = Math.random): HTMLElement | null {
  if (typeof document === "undefined" || prefersReducedMotion()) return null;

  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.dataset.dollarBurst = "";
  Object.assign(layer.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "2147483647",
  });

  const count = MIN_PARTICLES + Math.floor(random() * (MAX_PARTICLES - MIN_PARTICLES + 1));
  for (let i = 0; i < count; i++) {
    const particle = document.createElement("span");
    particle.textContent = "$";
    Object.assign(particle.style, {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      fontSize: `${12 + random() * 8}px`,
      fontWeight: "700",
      lineHeight: "1",
      color: COLORS[Math.floor(random() * COLORS.length)],
      pointerEvents: "none",
      userSelect: "none",
      willChange: "transform, opacity",
      transform: "translate(-50%, -50%)",
    });
    layer.appendChild(particle);

    if (typeof particle.animate !== "function") continue;

    // Launch mostly upward — within ±75° of straight up — then let gravity
    // arc each particle back down while it fades over the last ~45%.
    const angle = -Math.PI / 2 + (random() - 0.5) * ((5 * Math.PI) / 6);
    const speed = 100 + random() * 117; // px/s
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const spin = (random() - 0.5) * 720;
    const duration = BURST_DURATION_MS * (0.85 + random() * 0.15);

    const frames: Keyframe[] = [];
    for (let s = 0; s <= KEYFRAME_SAMPLES; s++) {
      const t = s / KEYFRAME_SAMPLES;
      const sec = (t * duration) / 1000;
      const dx = vx * sec;
      const dy = vy * sec + 0.5 * GRAVITY * sec * sec;
      frames.push({
        offset: t,
        transform: `translate(-50%, -50%) translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${(spin * t).toFixed(1)}deg)`,
        // Rounded so the final frame is exactly 0, not a float remainder.
        opacity: t < 0.55 ? 1 : Math.max(0, Math.round((1 - (t - 0.55) / 0.45) * 1000) / 1000),
      });
    }
    particle.animate(frames, { duration, easing: "linear", fill: "forwards" });
  }

  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), BURST_DURATION_MS + 100);
  return layer;
}

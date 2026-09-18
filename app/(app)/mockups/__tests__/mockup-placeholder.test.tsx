// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import MockupCanvas from "../MockupCanvas";
import type { Calibration, Raster } from "@/lib/mockup/types";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

const raster = (w: number, h: number): Raster => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
const mock = raster(40, 30);
const design = raster(10, 10);
const calibration = {
  qs: [
    [
      [0.3, 0.3],
      [0.7, 0.3],
      [0.7, 0.7],
      [0.3, 0.7],
    ],
  ],
  shade: 0,
} as unknown as Calibration;

function canvas(d: Raster | null) {
  return (
    <MockupCanvas
      mock={mock}
      overlays={[]}
      design={d}
      calibration={calibration}
      activeArea={0}
      cornerMode="free"
      onAreaChange={() => {}}
    />
  );
}

describe("mockup preview placeholder", () => {
  it("shows the wordmark without a design, hides it with one, and brings it back when the design is removed", () => {
    const { rerender, container } = render(canvas(null));
    const placeholder = screen.getByTestId("mockup-placeholder");
    expect(placeholder).toHaveTextContent("LISTHOUSE");
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    // A DOM layer over the canvas — never drawn into the canvas a render or download reads.
    expect(container.querySelector("canvas")?.childElementCount).toBe(0);
    expect(placeholder.closest("canvas")).toBeNull();

    rerender(canvas(design));
    expect(screen.queryByTestId("mockup-placeholder")).toBeNull();

    rerender(canvas(null));
    expect(screen.getByTestId("mockup-placeholder")).toBeInTheDocument();
  });
});

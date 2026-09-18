// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, useToast, type ToastInput } from "../toast/ToastProvider";
import { TOAST_DURATION_MS } from "../toast/config";

const { burstMock, reducedMotion } = vi.hoisted(() => ({
  burstMock: vi.fn(),
  reducedMotion: { value: false },
}));
vi.mock("@/app/(app)/dollar-burst", () => ({
  burstDollars: burstMock,
  prefersReducedMotion: () => reducedMotion.value,
}));

function Trigger({ toast }: { toast: ToastInput }) {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show(toast)}>
      Notify
    </button>
  );
}

function renderToaster(toast: ToastInput = { message: "Synced to Etsy.", kind: "success" }) {
  render(
    <ToastProvider>
      <Trigger toast={toast} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Notify" }));
}

beforeEach(() => {
  vi.useFakeTimers();
  burstMock.mockReset();
  reducedMotion.value = false;
});

afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error — jsdom has no Web Animations API; some tests add a stub.
  delete HTMLElement.prototype.animate;
});

describe("toasts", () => {
  test("shows the message with a close button, as a status for success and an alert for errors", () => {
    renderToaster();
    expect(screen.getByRole("status")).toHaveTextContent("Synced to Etsy.");
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getAllByRole("status")).toHaveLength(2);
  });

  test("an error toast is an alert", () => {
    renderToaster({ message: "Sync to Etsy failed.", kind: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent("Sync to Etsy failed.");
  });

  test("showing the same id again replaces the toast instead of stacking", () => {
    renderToaster({ message: "Synced to Etsy.", id: "sync" });
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  test("dismisses itself after 6 seconds", () => {
    renderToaster();
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 1));
    expect(screen.getByText("Synced to Etsy.")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Synced to Etsy.")).not.toBeInTheDocument();
  });

  test("hovering pauses the timer, and leaving resumes it with the time that was left", () => {
    renderToaster();
    act(() => vi.advanceTimersByTime(4000));
    fireEvent.mouseEnter(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByText("Synced to Etsy.")).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(1999));
    expect(screen.getByText("Synced to Etsy.")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Synced to Etsy.")).not.toBeInTheDocument();
  });

  test("the close button dismisses it immediately", () => {
    renderToaster();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Synced to Etsy.")).not.toBeInTheDocument();
  });

  test("once it settles, it shakes and pops 3–5 dollar signs", async () => {
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }));
    HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
    renderToaster();
    await act(async () => {});

    expect(animate).toHaveBeenCalledTimes(2);
    const [enterFrames] = animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(enterFrames[0]).toMatchObject({ opacity: 0, transform: "translateY(16px)" });
    const [shakeFrames] = animate.mock.calls[1] as unknown as [Keyframe[]];
    expect(shakeFrames.some((f) => String(f.transform).includes("translateX(-3px)"))).toBe(true);

    expect(burstMock).toHaveBeenCalledTimes(1);
    const { count } = burstMock.mock.calls[0][3] as { count: number };
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThanOrEqual(5);
  });

  test("under prefers-reduced-motion it only fades: no slide, no shake, no dollars", async () => {
    reducedMotion.value = true;
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }));
    HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];
    renderToaster();
    await act(async () => {});

    expect(animate).toHaveBeenCalledTimes(1);
    const [frames] = animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(frames.every((f) => f.transform === undefined)).toBe(true);
    expect(burstMock).not.toHaveBeenCalled();
    expect(screen.getByText("Synced to Etsy.")).toBeInTheDocument();
  });

  test("without a provider, showing a toast is a harmless no-op", () => {
    render(<Trigger toast={{ message: "Hello" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.queryByText("Hello")).not.toBeInTheDocument();
  });
});

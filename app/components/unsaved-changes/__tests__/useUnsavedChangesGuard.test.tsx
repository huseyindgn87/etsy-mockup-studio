// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useUnsavedChangesGuard } from "../useUnsavedChangesGuard";

/** Stands in for a page: an in-app link whose own handler plays the router. */
function Harness({ count, onNavigate }: { count: number; onNavigate: () => void }) {
  const { guard, dialog } = useUnsavedChangesGuard(count);
  return (
    <div>
      <a
        href="/listings"
        onClick={(e) => {
          e.preventDefault();
          onNavigate();
        }}
      >
        Back to listings
      </a>
      <a href="https://www.etsy.com/listing/1" target="_blank" rel="noreferrer" onClick={(e) => e.preventDefault()}>
        Etsy
      </a>
      <button type="button" onClick={() => guard(onNavigate)}>
        Cancel
      </button>
      {dialog}
    </div>
  );
}

function reload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("with unsaved changes", () => {
  test("an in-app link click is held and the dialog names the count", () => {
    const onNavigate = vi.fn();
    render(<Harness count={2} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("link", { name: "Back to listings" }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("2 listings have unsaved changes");
  });

  test("Stay keeps the page; Discard carries on to where the click was going", () => {
    const onNavigate = vi.fn();
    render(<Harness count={1} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("link", { name: "Back to listings" }));
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "Back to listings" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  test("a guarded router navigation asks first", () => {
    const onNavigate = vi.fn();
    render(<Harness count={1} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("1 listing has unsaved changes");
  });

  test("closing or reloading the tab is warned about", () => {
    render(<Harness count={1} onNavigate={vi.fn()} />);
    expect(reload().defaultPrevented).toBe(true);
  });

  test("a link opening Etsy in a new tab isn't held", () => {
    render(<Harness count={1} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("link", { name: "Etsy" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("with nothing unsaved", () => {
  test("links, guarded navigation and reloads pass straight through", () => {
    const onNavigate = vi.fn();
    render(<Harness count={0} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("link", { name: "Back to listings" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(reload().defaultPrevented).toBe(false);
  });

  test("once a save brings the count back to zero, the warning stops", () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<Harness count={1} onNavigate={onNavigate} />);
    expect(reload().defaultPrevented).toBe(true);
    rerender(<Harness count={0} onNavigate={onNavigate} />);
    expect(reload().defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "Back to listings" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

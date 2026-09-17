// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useUnsavedChangesGuard } from "../useUnsavedChangesGuard";

/** Stands in for a page: an in-app link whose own handler plays the router. */
function Harness({
  count,
  onNavigate,
  onSave,
}: {
  count: number;
  onNavigate: () => void;
  onSave?: () => Promise<boolean>;
}) {
  const { guard, dialog } = useUnsavedChangesGuard(count, { onSave });
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
        Router push
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

  test("Cancel keeps the page; Discard carries on to where the click was going", () => {
    const onNavigate = vi.fn();
    render(<Harness count={1} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("link", { name: "Back to listings" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Router push" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Router push" }));
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

describe("the browser Back button", () => {
  test("is held by an extra history entry, and leaves only once the user says so", async () => {
    const onNavigate = vi.fn();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const entries = () => window.history.length;

    const before = entries();
    render(<Harness count={1} onNavigate={onNavigate} />);
    // The sentinel entry, pushed so the first Back press lands back on this page.
    expect(entries()).toBe(before + 1);

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("alertdialog")).toHaveTextContent("1 listing has unsaved changes");
    expect(go).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(go).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    // Both the sentinel and the entry the user wanted to leave.
    expect(go).toHaveBeenCalledWith(-2);
    go.mockRestore();
  });

  test("passes straight through with nothing unsaved", async () => {
    render(<Harness count={0} onNavigate={vi.fn()} />);
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("Save and leave", () => {
  test("saves, then carries on to where the click was going", async () => {
    const onNavigate = vi.fn();
    const onSave = vi.fn(async () => true);
    render(<Harness count={1} onNavigate={onNavigate} onSave={onSave} />);

    fireEvent.click(screen.getByRole("link", { name: "Back to listings" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and leave" }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  test("a failed save keeps the page and says so", async () => {
    const onNavigate = vi.fn();
    render(<Harness count={1} onNavigate={onNavigate} onSave={async () => false} />);

    fireEvent.click(screen.getByRole("link", { name: "Back to listings" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and leave" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save"));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  test("isn't offered when the page has no way to save", () => {
    render(<Harness count={1} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("link", { name: "Back to listings" }));
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
  });
});

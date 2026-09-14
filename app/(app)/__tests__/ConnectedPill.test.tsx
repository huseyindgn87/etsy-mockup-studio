// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ConnectedPill from "../ConnectedPill";

describe("ConnectedPill", () => {
  it("hides the user id and expiry until clicked, then reveals them in a popover", () => {
    render(<ConnectedPill userId="12345" expiresAt={Date.now() + 60_000} />);

    expect(screen.getByRole("button", { name: /Connected/i })).toBeInTheDocument();
    expect(screen.queryByText("12345")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Connected/i }));

    const dialog = screen.getByRole("dialog", { name: "Connection details" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("12345")).toBeInTheDocument();
    expect(screen.getByText(/Etsy user id/i)).toBeInTheDocument();
    expect(screen.getByText(/Token expires/i)).toBeInTheDocument();
  });

  it("closes again when clicked a second time", () => {
    render(<ConnectedPill userId="12345" expiresAt={Date.now() + 60_000} />);

    const button = screen.getByRole("button", { name: /Connected/i });
    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

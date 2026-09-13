// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ListingPreviewModal, { type PreviewMediaItem, type PreviewVariationDim } from "../ListingPreviewModal";

const MEDIA: PreviewMediaItem[] = [
  { id: "photo:1", kind: "photo", url: "blob:photo-1", label: "Front" },
  { id: "photo:2", kind: "photo", url: "blob:photo-2", label: "Back" },
  { id: "video:0", kind: "video", url: "blob:video-0", label: "Video 1" },
];

const VARIATIONS: PreviewVariationDim[] = [
  { name: "Color", values: ["Red", "Blue"] },
  { name: "Size", values: ["Small", "Large"] },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof ListingPreviewModal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ListingPreviewModal
      title="Miami Skyline Print"
      description="A lovely print."
      priceLabel="$18.00+"
      variations={VARIATIONS}
      media={MEDIA}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onClose, ...utils };
}

describe("ListingPreviewModal", () => {
  it("renders title, price range, variation dropdowns and the photo rail", () => {
    renderModal();

    expect(screen.getByRole("dialog", { name: "Listing preview" })).toBeInTheDocument();
    expect(screen.getByText("Miami Skyline Print")).toBeInTheDocument();
    expect(screen.getByText("$18.00+")).toBeInTheDocument();

    expect(screen.getByText("Color")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getAllByText("Select an option")).toHaveLength(2);
    expect(screen.getAllByText("*")).toHaveLength(2);

    expect(screen.getByLabelText("Front")).toBeInTheDocument();
    expect(screen.getByLabelText("Back")).toBeInTheDocument();
    expect(screen.getByLabelText("Video 1 (video)")).toBeInTheDocument();
  });

  it("shows a single price with no + when there is no range", () => {
    renderModal({ priceLabel: "$24.00" });
    expect(screen.getByText("$24.00")).toBeInTheDocument();
    expect(screen.queryByText(/\+/)).not.toBeInTheDocument();
  });

  it("handles empty photos, variations and description", () => {
    renderModal({ media: [], variations: [], description: "" });
    expect(screen.getByText("No photos")).toBeInTheDocument();
    expect(screen.getByText("No photos yet")).toBeInTheDocument();
    expect(screen.getByText("No description yet.")).toBeInTheDocument();
    expect(screen.queryByText("Select an option")).not.toBeInTheDocument();
  });

  it("switches the main image on thumbnail click and highlights the active one", () => {
    renderModal();
    const backThumb = screen.getByLabelText("Back");
    fireEvent.click(backThumb);
    expect(backThumb).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("img", { name: "Back" })).toBeInTheDocument();
  });

  it("navigates with the prev/next arrow buttons, wrapping around", () => {
    const { container } = renderModal();
    expect(screen.getByRole("img", { name: "Front" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Previous photo"));
    // wraps to the last item, the video
    expect(container.querySelector("video")).toHaveAttribute("src", "blob:video-0");

    fireEvent.click(screen.getByLabelText("Next photo"));
    expect(screen.getByRole("img", { name: "Front" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Next photo"));
    expect(screen.getByRole("img", { name: "Back" })).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click but not on a click inside the panel", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByText("Miami Skyline Print"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on the X button", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByLabelText("Close preview"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

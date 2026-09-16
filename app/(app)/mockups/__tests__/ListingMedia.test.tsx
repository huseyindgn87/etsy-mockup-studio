// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import { MAX_LISTING_VIDEOS } from "@/lib/etsy/video-limits";
import { PhotoEnlargeModal, PhotoGrid, VideoSection, type PhotoSlot } from "../ListingMedia";
import { moveItem, withAltText } from "../photo-order";

const makeSlots = (n: number): PhotoSlot[] =>
  Array.from({ length: n }, (_, i) => ({
    slotId: `own:o${i + 1}`,
    ref: { kind: "own", id: `o${i + 1}` },
    thumbnailUrl: `blob:o${i + 1}`,
    label: `photo-${i + 1}.jpg`,
  }));

function Harness({
  initial,
  altText = {},
  onAddOwn = () => {},
}: {
  initial: PhotoSlot[];
  altText?: Record<string, string>;
  onAddOwn?: (files: File[]) => void;
}) {
  const [slots, setSlots] = useState(initial);
  const [alt, setAlt] = useState(altText);
  const [editing, setEditing] = useState<string | null>(null);
  const [focusAlt, setFocusAlt] = useState(false);
  const editingSlot = slots.find((s) => s.slotId === editing);
  return (
    <>
      <PhotoGrid
        slots={slots}
        altTextBySlot={alt}
        onMove={(from, to) => setSlots((prev) => moveItem(prev, from, to))}
        onRemove={(slotId) => setSlots((prev) => prev.filter((s) => s.slotId !== slotId))}
        onEnlarge={(slotId) => {
          setFocusAlt(false);
          setEditing(slotId);
        }}
        onEditAltText={(slotId) => {
          setFocusAlt(true);
          setEditing(slotId);
        }}
        onAddOwn={onAddOwn}
      />
      {editingSlot && (
        <PhotoEnlargeModal
          slot={editingSlot}
          index={slots.indexOf(editingSlot)}
          altText={alt[editingSlot.slotId] ?? ""}
          focusAltText={focusAlt}
          onAltTextChange={(text) => setAlt((prev) => withAltText(prev, editingSlot.slotId, text))}
          onMakeThumbnail={() => {}}
          onClose={() => setEditing(null)}
        />
      )}
      <output data-testid="alt-state">{JSON.stringify(alt)}</output>
    </>
  );
}

const tileLabels = () =>
  within(screen.getByRole("list", { name: "Listing photos" }))
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("aria-label"))
    .filter((label): label is string => !!label?.startsWith("Photo "))
    .map((label) => label.replace(/^Photo \d+: /, ""));

const tile = (label: string) => screen.getByRole("listitem", { name: new RegExp(`: ${label}$`) });

function drag(from: HTMLElement, to: HTMLElement) {
  fireEvent.dragStart(from);
  fireEvent.dragOver(to);
  fireEvent.drop(to);
  fireEvent.dragEnd(from);
}

describe("PhotoGrid reordering", () => {
  it("drags the first tile to the last position", () => {
    render(<Harness initial={makeSlots(10)} />);
    drag(tile("photo-1.jpg"), tile("photo-10.jpg"));
    expect(tileLabels()).toEqual([
      "photo-2.jpg",
      "photo-3.jpg",
      "photo-4.jpg",
      "photo-5.jpg",
      "photo-6.jpg",
      "photo-7.jpg",
      "photo-8.jpg",
      "photo-9.jpg",
      "photo-10.jpg",
      "photo-1.jpg",
    ]);
  });

  it("drags the last tile into the middle", () => {
    render(<Harness initial={makeSlots(5)} />);
    drag(tile("photo-5.jpg"), tile("photo-3.jpg"));
    expect(tileLabels()).toEqual(["photo-1.jpg", "photo-2.jpg", "photo-5.jpg", "photo-3.jpg", "photo-4.jpg"]);
  });

  it("ignores files dragged in from outside the grid", () => {
    render(<Harness initial={makeSlots(3)} />);
    fireEvent.dragOver(tile("photo-3.jpg"));
    fireEvent.drop(tile("photo-3.jpg"));
    expect(tileLabels()).toEqual(["photo-1.jpg", "photo-2.jpg", "photo-3.jpg"]);
  });

  it("moves tiles left and right from the keyboard", () => {
    render(<Harness initial={makeSlots(3)} />);
    fireEvent.click(screen.getByRole("button", { name: "Move photo 1 right" }));
    expect(tileLabels()).toEqual(["photo-2.jpg", "photo-1.jpg", "photo-3.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: "Move photo 3 left" }));
    expect(tileLabels()).toEqual(["photo-2.jpg", "photo-3.jpg", "photo-1.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: "Move photo 1 left" }));
    expect(tileLabels()).toEqual(["photo-2.jpg", "photo-3.jpg", "photo-1.jpg"]);
  });
});

describe("PhotoGrid remove", () => {
  it("removes exactly the tile whose X was clicked, in one click", () => {
    render(<Harness initial={makeSlots(4)} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo 3" }));
    expect(tileLabels()).toEqual(["photo-1.jpg", "photo-2.jpg", "photo-4.jpg"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("no longer offers a Remove button in the enlarged view", () => {
    render(<Harness initial={makeSlots(2)} />);
    fireEvent.click(screen.getByRole("button", { name: "View photo 2" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});

describe("PhotoGrid alt text", () => {
  it("opens the alt text field for that image and saves text per image", () => {
    render(<Harness initial={makeSlots(3)} />);
    fireEvent.click(screen.getByRole("button", { name: "Alt text for photo 2" }));
    const dialog = screen.getByRole("dialog", { name: "photo-2.jpg" });
    const field = within(dialog).getByRole("textbox");
    expect(field).toHaveFocus();
    expect(within(dialog).getByText("500 characters remaining")).toBeInTheDocument();

    fireEvent.change(field, { target: { value: "Mug on a desk" } });
    expect(within(dialog).getByText("487 characters remaining")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(JSON.parse(screen.getByTestId("alt-state").textContent!)).toEqual({ "own:o2": "Mug on a desk" });
    expect(screen.getByRole("button", { name: "Alt text for photo 2" })).toHaveAttribute("data-state", "filled");
    expect(screen.getByRole("button", { name: "Alt text for photo 1" })).toHaveAttribute("data-state", "empty");
  });

  it("caps alt text at 500 characters", () => {
    render(<Harness initial={makeSlots(1)} />);
    fireEvent.click(screen.getByRole("button", { name: "Alt text for photo 1" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x".repeat(600) } });
    expect(screen.getByRole("textbox")).toHaveValue("x".repeat(500));
    expect(screen.getByText("0 characters remaining")).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId("alt-state").textContent!)["own:o1"]).toHaveLength(500);
  });

  it("shows tiles that already have alt text as filled", () => {
    render(<Harness initial={makeSlots(2)} altText={{ "own:o1": "Front view" }} />);
    expect(screen.getByRole("button", { name: "Alt text for photo 1" })).toHaveAttribute("data-state", "filled");
    expect(screen.getByRole("button", { name: "Alt text for photo 2" })).toHaveAttribute("data-state", "empty");
  });
});

describe("PhotoGrid empty slots", () => {
  it("fills the rest of the 20 slots with plus buttons that open the file picker", () => {
    const onAddOwn = vi.fn();
    const { container } = render(<Harness initial={makeSlots(3)} onAddOwn={onAddOwn} />);
    const empties = screen.getAllByRole("button", { name: /^Add a photo to slot \d+$/ });
    expect(empties).toHaveLength(MAX_LISTING_IMAGES - 3);
    expect(empties[0].querySelector("svg")).not.toBeNull();

    const input = container.querySelector<HTMLInputElement>('[data-testid="photo-file-input"]')!;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Add a photo to slot 12" }));
    expect(click).toHaveBeenCalledTimes(1);

    const file = new File(["x"], "new.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAddOwn).toHaveBeenCalledWith([file]);
    expect(screen.getByRole("button", { name: "Upload your own" })).toBeInTheDocument();
  });
});

function VideoHarness({ initial }: { initial: (File | null)[] }) {
  const [videos, setVideos] = useState(initial);
  return (
    <VideoSection
      videos={videos}
      errors={videos.map(() => null)}
      onSelect={(slot, file) => setVideos((prev) => prev.map((v, i) => (i === slot ? file : v)))}
      onMove={(from, to) => setVideos((prev) => moveItem(prev, from, to))}
    />
  );
}

describe("VideoSection", () => {
  const clip = (name: string) => new File(["v"], name, { type: "video/mp4" });

  it("has no alt text button, but reorders and removes from the tile", () => {
    URL.createObjectURL = vi.fn(() => "blob:video");
    URL.revokeObjectURL = vi.fn();
    const videos = [clip("a.mp4"), clip("b.mp4")].slice(0, MAX_LISTING_VIDEOS);
    render(<VideoHarness initial={videos} />);

    expect(screen.queryByRole("button", { name: /alt text/i })).not.toBeInTheDocument();

    drag(
      screen.getByRole("listitem", { name: "Video slot 1" }),
      screen.getByRole("listitem", { name: "Video slot 2" }),
    );
    expect(screen.getByRole("listitem", { name: "Video slot 1" })).toHaveTextContent("b.mp4");
    expect(screen.getByRole("listitem", { name: "Video slot 2" })).toHaveTextContent("a.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Move video 2 left" }));
    expect(screen.getByRole("listitem", { name: "Video slot 1" })).toHaveTextContent("a.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Remove video 1" }));
    expect(screen.getByRole("button", { name: "Upload a video to slot 1" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Video slot 2" })).toHaveTextContent("b.mp4");
  });

  it("opens the file picker from an empty video slot", () => {
    const { container } = render(<VideoHarness initial={[null, null]} />);
    const input = container.querySelector<HTMLInputElement>('[data-testid="video-file-input-1"]')!;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Upload a video to slot 2" }));
    expect(click).toHaveBeenCalledTimes(1);
  });
});

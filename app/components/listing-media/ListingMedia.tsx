"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACCEPTED_IMAGE_EXTENSIONS,
  MAX_ALT_TEXT_LENGTH,
  MAX_LISTING_IMAGES,
} from "@/lib/etsy/listing-image-limits";
import {
  ACCEPTED_VIDEO_EXTENSIONS,
  MAX_LISTING_VIDEOS,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_SIZE_BYTES,
  MIN_VIDEO_DURATION_SECONDS,
} from "@/lib/etsy/video-limits";
import type { ImageSlotRef } from "./photo-order";

/** One photo-grid slot — a rendered mockup×design combo, a user-uploaded photo, or a photo already on Etsy. */
export interface PhotoSlot {
  slotId: string;
  ref: ImageSlotRef;
  thumbnailUrl: string | null;
  label: string;
}

/**
 * Drag-to-reorder within one strip of tiles. The source index lives in state
 * rather than only in `dataTransfer`, so files dragged in from the desktop (or
 * tiles from another strip) are never mistaken for a move.
 */
function useTileDrag(onMove: (from: number, to: number) => void) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const reset = () => {
    setDragFrom(null);
    setDropAt(null);
  };
  return {
    dragFrom,
    dropAt,
    source: (index: number) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        setDragFrom(index);
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(index));
        }
      },
      onDragEnd: reset,
    }),
    target: (to: number) => ({
      onDragOver: (e: React.DragEvent) => {
        if (dragFrom === null) return;
        e.preventDefault();
        if (dropAt !== to) setDropAt(to);
      },
      onDragLeave: () => setDropAt((cur) => (cur === to ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        if (dragFrom === null) return;
        e.preventDefault();
        onMove(dragFrom, to);
        reset();
      },
    }),
  };
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden className={className}>
      <path strokeLinecap="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}

const TILE_ICON_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-sm leading-none text-white hover:bg-black/90";

/** Keyboard alternative to dragging — only visible while the tile has focus. */
function MoveButtons({
  noun,
  index,
  count,
  onMove,
}: {
  noun: string;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
}) {
  const buttons = [
    { label: "left", to: index - 1, glyph: "‹", disabled: index === 0 },
    { label: "right", to: index + 1, glyph: "›", disabled: index >= count - 1 },
  ];
  return (
    <span className="pointer-events-none absolute bottom-1 right-1 flex gap-0.5 opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          aria-label={`Move ${noun} ${index + 1} ${b.label}`}
          aria-disabled={b.disabled}
          onClick={() => {
            if (!b.disabled) onMove(index, b.to);
          }}
          className={`${TILE_ICON_BUTTON} aria-disabled:opacity-40`}
        >
          {b.glyph}
        </button>
      ))}
    </span>
  );
}

/**
 * The listing's photo slots: rendered mockups and user-uploaded photos,
 * filling Etsy's `MAX_LISTING_IMAGES` image slots. Tiles drag (or move with
 * their arrow buttons) to reorder — that order becomes the Etsy upload rank,
 * so slot 1 is always the listing thumbnail. Every change here is local to
 * the editor; nothing reaches Etsy until the listing is published.
 */
export function PhotoGrid({
  slots,
  altTextBySlot,
  onMove,
  onRemove,
  onEnlarge,
  onEditAltText,
  onAddOwn,
}: {
  slots: PhotoSlot[];
  altTextBySlot: Record<string, string>;
  onMove: (from: number, to: number) => void;
  onRemove: (slotId: string) => void;
  onEnlarge: (slotId: string) => void;
  onEditAltText: (slotId: string) => void;
  onAddOwn: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const emptyCount = Math.max(0, MAX_LISTING_IMAGES - slots.length);
  const drag = useTileDrag(onMove);
  const openPicker = () => inputRef.current?.click();

  return (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-50">
          Photos{" "}
          <span className="font-normal text-zinc-500">
            ({slots.length}/{MAX_LISTING_IMAGES})
          </span>
        </h4>
        <button
          type="button"
          onClick={openPicker}
          className="h-8 rounded-full border border-black/10 px-3 text-xs font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
        >
          Upload your own
        </button>
        <input
          ref={inputRef}
          type="file"
          data-testid="photo-file-input"
          accept={ACCEPTED_IMAGE_EXTENSIONS.map((e) => `.${e}`).join(",")}
          multiple
          hidden
          onChange={(e) => {
            onAddOwn([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      <ol aria-label="Listing photos" className="grid grid-cols-4 gap-2 sm:grid-cols-5 md:grid-cols-7">
        {slots.map((slot, i) => {
          const hasAltText = (altTextBySlot[slot.slotId] ?? "").trim() !== "";
          return (
            <li
              key={slot.slotId}
              {...drag.source(i)}
              {...drag.target(i)}
              aria-label={`Photo ${i + 1}: ${slot.label}`}
              title={slot.label}
              className={`group relative aspect-square cursor-grab overflow-hidden rounded-lg border bg-zinc-100 active:cursor-grabbing dark:bg-zinc-900 ${
                drag.dropAt === i && drag.dragFrom !== i
                  ? "border-primary ring-2 ring-primary"
                  : "border-black/10 dark:border-white/15"
              } ${drag.dragFrom === i ? "opacity-50" : ""}`}
            >
              <div
                role="button"
                tabIndex={0}
                aria-label={`View photo ${i + 1}`}
                onClick={() => onEnlarge(slot.slotId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onEnlarge(slot.slotId);
                  }
                }}
                className="h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              >
                {slot.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={slot.thumbnailUrl}
                    alt={altTextBySlot[slot.slotId] || slot.label}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[10px] text-zinc-400">
                    Rendering…
                  </span>
                )}
              </div>
              <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-medium text-white">
                {i === 0 ? "Thumbnail" : i + 1}
              </span>
              <button
                type="button"
                aria-label={`Remove photo ${i + 1}`}
                onClick={() => onRemove(slot.slotId)}
                className={`${TILE_ICON_BUTTON} absolute right-1 top-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100`}
              >
                ×
              </button>
              <button
                type="button"
                aria-label={`Alt text for photo ${i + 1}`}
                data-state={hasAltText ? "filled" : "empty"}
                onClick={() => onEditAltText(slot.slotId)}
                className={`absolute bottom-1 left-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  hasAltText
                    ? "bg-primary text-white"
                    : "bg-black/70 text-white opacity-0 hover:bg-black/90 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                }`}
              >
                {hasAltText ? "✓ Alt text" : "Alt text"}
              </button>
              <MoveButtons noun="photo" index={i} count={slots.length} onMove={onMove} />
            </li>
          );
        })}

        {Array.from({ length: emptyCount }).map((_, i) => {
          const n = slots.length + i + 1;
          return (
            <li key={`empty-${i}`} {...(slots.length > 0 ? drag.target(slots.length - 1) : {})}>
              <button
                type="button"
                onClick={openPicker}
                aria-label={`Add a photo to slot ${n}`}
                className="flex aspect-square w-full flex-col items-center justify-center gap-0.5 rounded-lg border-2 border-dashed border-black/10 text-zinc-400 hover:border-black/30 hover:text-zinc-600 dark:border-white/15 dark:hover:border-white/40 dark:hover:text-zinc-300"
              >
                <PlusIcon className="h-5 w-5" />
                <span className="text-[10px]">{n}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Enlarged view of one photo-grid slot, with its alt-text field and remaining-character counter. */
export function PhotoEnlargeModal({
  slot,
  index,
  altText,
  focusAltText = false,
  onAltTextChange,
  onMakeThumbnail,
  onClose,
}: {
  slot: PhotoSlot;
  index: number;
  altText: string;
  focusAltText?: boolean;
  onAltTextChange: (text: string) => void;
  onMakeThumbnail: () => void;
  onClose: () => void;
}) {
  const remaining = MAX_ALT_TEXT_LENGTH - altText.length;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={slot.label}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-zinc-950 sm:flex-row"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-100 p-2 dark:bg-zinc-900">
          {slot.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={slot.thumbnailUrl}
              alt={slot.label}
              className="max-h-[70vh] w-full object-contain sm:max-h-[80vh]"
            />
          ) : (
            <p className="p-10 text-sm text-zinc-500">Rendering…</p>
          )}
        </div>

        <div className="w-full space-y-3 p-4 sm:w-72">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {index === 0 ? "Listing thumbnail" : slot.label}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              ×
            </button>
          </div>

          <label className="block text-sm">
            <span className="flex justify-between text-xs text-zinc-500">
              <span>Alt text</span>
              <span className={`font-mono ${remaining === 0 ? "text-red-600" : ""}`} aria-live="polite">
                {remaining} characters remaining
              </span>
            </span>
            <textarea
              rows={4}
              value={altText}
              maxLength={MAX_ALT_TEXT_LENGTH}
              autoFocus={focusAltText}
              onChange={(e) => onAltTextChange(e.target.value.slice(0, MAX_ALT_TEXT_LENGTH))}
              placeholder="Describe this image for screen readers and search…"
              className="mt-1 w-full resize-y rounded-lg border border-black/10 bg-white px-2 py-1.5 text-sm outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-900"
            />
          </label>

          {index > 0 && (
            <button
              type="button"
              onClick={onMakeThumbnail}
              className="h-8 rounded-full border border-black/10 px-3 text-xs font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              Make listing thumbnail
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A filled video slot: a file picked in this session, or a video already on the Etsy listing. */
export type ListingVideoItem =
  /** `id` names a picked file's stored copy once the editor saves it with a draft. */
  | { kind: "file"; id?: string; file: File }
  | { kind: "etsy"; videoId: number; videoUrl: string; thumbnailUrl: string };

/**
 * Video slots — one per `MAX_LISTING_VIDEOS`, matching Etsy's per-listing
 * video cap. Tiles reorder like photos (the save sends them in slot
 * order). Format and size are checked as soon as a file is picked; duration
 * is checked once the browser can decode its metadata — an unreadable
 * duration (an unusual codec) doesn't block the file, since Etsy is still the
 * final check.
 */
export function VideoSection({
  videos,
  errors,
  onSelect,
  onMove,
}: {
  videos: (ListingVideoItem | null)[];
  errors: (string | null)[];
  onSelect: (slot: number, file: File | null) => void;
  onMove: (from: number, to: number) => void;
}) {
  const drag = useTileDrag(onMove);
  return (
    <div className="space-y-4">
      <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50">Video</h3>
      <p className="text-sm text-zinc-500">
        Up to {MAX_LISTING_VIDEOS} videos, {Math.round(MAX_VIDEO_SIZE_BYTES / (1024 * 1024))} MB
        each, {MIN_VIDEO_DURATION_SECONDS}-{MAX_VIDEO_DURATION_SECONDS} seconds long. Accepted
        formats: {ACCEPTED_VIDEO_EXTENSIONS.join(", ").toUpperCase()}. Etsy removes audio on
        upload.
      </p>
      <ol aria-label="Listing videos" className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 sm:max-w-xl">
        {videos.map((video, i) => (
          <VideoSlot
            key={i}
            slot={i}
            count={videos.length}
            video={video}
            error={errors[i] ?? null}
            onSelect={onSelect}
            onMove={onMove}
            dragSource={video ? drag.source(i) : {}}
            dragTarget={drag.target(i)}
            isDropTarget={drag.dropAt === i && drag.dragFrom !== i}
          />
        ))}
      </ol>
    </div>
  );
}

function VideoSlot({
  slot,
  count,
  video,
  error,
  onSelect,
  onMove,
  dragSource,
  dragTarget,
  isDropTarget,
}: {
  slot: number;
  count: number;
  video: ListingVideoItem | null;
  error: string | null;
  onSelect: (slot: number, file: File | null) => void;
  onMove: (from: number, to: number) => void;
  dragSource: React.LiHTMLAttributes<HTMLLIElement>;
  dragTarget: React.LiHTMLAttributes<HTMLLIElement>;
  isDropTarget: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const file = video?.kind === "file" ? video.file : null;
  const objectUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);
  const url = video?.kind === "etsy" ? video.videoUrl : objectUrl;

  return (
    <li {...dragSource} {...dragTarget} aria-label={`Video slot ${slot + 1}`} className="min-w-0 space-y-2">
      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
      {video && (url || video.kind === "etsy") ? (
        <>
          <div
            className={`group relative aspect-video cursor-grab overflow-hidden rounded-lg border bg-black active:cursor-grabbing ${
              isDropTarget ? "border-primary ring-2 ring-primary" : "border-black/10 dark:border-white/15"
            }`}
          >
            <video
              src={url || undefined}
              poster={video.kind === "etsy" ? video.thumbnailUrl || undefined : undefined}
              controls
              className="h-full w-full object-contain"
            />
            <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-medium text-white">
              {slot + 1}
            </span>
            <button
              type="button"
              aria-label={`Remove video ${slot + 1}`}
              onClick={() => onSelect(slot, null)}
              className={`${TILE_ICON_BUTTON} absolute right-1 top-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100`}
            >
              ×
            </button>
            <MoveButtons noun="video" index={slot} count={count} onMove={onMove} />
          </div>
          <p className="min-w-0 truncate text-xs text-zinc-500">
            {video.kind === "file"
              ? `${video.file.name} · ${(video.file.size / (1024 * 1024)).toFixed(1)} MB`
              : "On Etsy"}
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-label={`Upload a video to slot ${slot + 1}`}
          className={`flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 text-sm text-zinc-500 hover:border-black/30 hover:text-zinc-700 dark:hover:border-white/40 dark:hover:text-zinc-300 ${
            isDropTarget ? "border-primary" : "border-black/15 dark:border-white/20"
          }`}
        >
          <PlusIcon className="h-6 w-6" />
          <span className="text-xs">Slot {slot + 1}</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        data-testid={`video-file-input-${slot}`}
        accept="video/*"
        hidden
        onChange={(e) => {
          onSelect(slot, e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
    </li>
  );
}

/**
 * The one photo + video tile grid every listing editor uses — the create
 * editor, an existing listing's editor, copies, and each row of the bulk
 * screen. Fully controlled: the caller owns the slots, alt text and videos
 * and decides when (and whether) anything is saved; this only opens the
 * enlarged view for a tile.
 */
export function ListingMediaEditor({
  sections = "all",
  slots,
  altTextBySlot,
  onMovePhoto,
  onRemovePhoto,
  onAltTextChange,
  onAddPhotos,
  videos = [],
  videoErrors = [],
  onSelectVideo = () => {},
  onMoveVideo = () => {},
}: {
  sections?: "all" | "photos" | "videos";
  slots: PhotoSlot[];
  altTextBySlot: Record<string, string>;
  onMovePhoto: (from: number, to: number) => void;
  onRemovePhoto: (slotId: string) => void;
  onAltTextChange: (slotId: string, text: string) => void;
  onAddPhotos: (files: File[]) => void;
  videos?: (ListingVideoItem | null)[];
  videoErrors?: (string | null)[];
  onSelectVideo?: (slot: number, file: File | null) => void;
  onMoveVideo?: (from: number, to: number) => void;
}) {
  const [enlarged, setEnlarged] = useState<{ slotId: string; focusAltText: boolean } | null>(null);
  const enlargedIndex = enlarged ? slots.findIndex((s) => s.slotId === enlarged.slotId) : -1;
  const enlargedSlot = enlargedIndex >= 0 ? slots[enlargedIndex] : null;

  return (
    <>
      {sections !== "videos" && (
        <PhotoGrid
          slots={slots}
          altTextBySlot={altTextBySlot}
          onMove={onMovePhoto}
          onRemove={onRemovePhoto}
          onEnlarge={(slotId) => setEnlarged({ slotId, focusAltText: false })}
          onEditAltText={(slotId) => setEnlarged({ slotId, focusAltText: true })}
          onAddOwn={onAddPhotos}
        />
      )}

      {sections !== "photos" && (
        <div className={sections === "all" ? "mt-8 border-t border-black/10 pt-6 dark:border-white/15" : ""}>
          <VideoSection videos={videos} errors={videoErrors} onSelect={onSelectVideo} onMove={onMoveVideo} />
        </div>
      )}

      {enlarged && enlargedSlot && (
        <PhotoEnlargeModal
          slot={enlargedSlot}
          index={enlargedIndex}
          altText={altTextBySlot[enlargedSlot.slotId] ?? ""}
          focusAltText={enlarged.focusAltText}
          onAltTextChange={(text) => onAltTextChange(enlargedSlot.slotId, text)}
          onMakeThumbnail={() => {
            if (enlargedIndex > 0) onMovePhoto(enlargedIndex, 0);
          }}
          onClose={() => setEnlarged(null)}
        />
      )}
    </>
  );
}

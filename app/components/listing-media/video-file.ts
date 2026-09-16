import { checkVideoDuration, checkVideoFileBasics } from "@/lib/etsy/video-limits";

/** Reads a video file's duration via a hidden `<video>` element — NaN if the browser can't decode it. */
export function probeVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(v.duration);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(NaN);
    };
    v.src = url;
  });
}

/** Why Etsy would refuse a picked video (format, size, then duration), or null. */
export async function checkPickedVideo(file: File): Promise<string | null> {
  return checkVideoFileBasics(file) ?? checkVideoDuration(await probeVideoDuration(file));
}

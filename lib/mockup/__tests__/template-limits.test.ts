import { describe, expect, test } from "vitest";
import {
  MAX_TEMPLATE_UPLOAD_BYTES,
  MIN_TEMPLATE_SHORT_EDGE,
  validateTemplateUpload,
} from "../template-limits";
import { encodeRaster } from "../server";
import { solid } from "./helpers";

describe("validateTemplateUpload", () => {
  test("accepts a JPEG at/above the minimum short edge", async () => {
    const bytes = await encodeRaster(solid(MIN_TEMPLATE_SHORT_EDGE, MIN_TEMPLATE_SHORT_EDGE + 200, 200, 100, 50), {
      format: "jpeg",
    });
    const res = await validateTemplateUpload(bytes);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.format).toBe("jpeg");
      expect(res.width).toBe(MIN_TEMPLATE_SHORT_EDGE);
      expect(res.height).toBe(MIN_TEMPLATE_SHORT_EDGE + 200);
    }
  });

  test("accepts a PNG at/above the minimum short edge", async () => {
    const bytes = await encodeRaster(solid(MIN_TEMPLATE_SHORT_EDGE, MIN_TEMPLATE_SHORT_EDGE, 10, 20, 30), {
      format: "png",
    });
    const res = await validateTemplateUpload(bytes);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.format).toBe("png");
  });

  test("rejects an image whose short edge is under the minimum", async () => {
    const bytes = await encodeRaster(solid(MIN_TEMPLATE_SHORT_EDGE - 1, MIN_TEMPLATE_SHORT_EDGE + 500, 1, 1, 1), {
      format: "png",
    });
    const res = await validateTemplateUpload(bytes);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/shorter side/i);
  });

  test("rejects a file over the size cap before even trying to decode it", async () => {
    const bytes = Buffer.alloc(MAX_TEMPLATE_UPLOAD_BYTES + 1);
    const res = await validateTemplateUpload(bytes);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too large/i);
  });

  test("rejects an empty file", async () => {
    const res = await validateTemplateUpload(Buffer.alloc(0));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/empty/i);
  });

  test("rejects bytes that aren't a decodable image", async () => {
    const res = await validateTemplateUpload(Buffer.from("not an image, just text"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not read/i);
  });

  test("rejects a decodable format that isn't JPEG/PNG (e.g. WebP)", async () => {
    const bytes = await encodeRaster(solid(MIN_TEMPLATE_SHORT_EDGE, MIN_TEMPLATE_SHORT_EDGE, 5, 5, 5), {
      format: "png",
    });
    // Re-encode as webp via sharp directly to get a real non-accepted format.
    const sharp = (await import("sharp")).default;
    const webp = await sharp(bytes).webp().toBuffer();
    const res = await validateTemplateUpload(webp);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/JPEG and PNG/i);
  });
});

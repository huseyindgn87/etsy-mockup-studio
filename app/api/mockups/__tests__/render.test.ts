import { afterAll, describe, expect, test, vi } from "vitest";
import sharp from "sharp";

vi.mock("@/lib/etsy/auth", () => ({
  getEtsySession: vi.fn(async () => ({
    userId: "1",
    accessToken: "a",
    refreshToken: "r",
    expiresAt: Date.now() + 1_000_000,
  })),
}));

import { getEtsySession } from "@/lib/etsy/auth";
import { POST } from "@/app/api/mockups/render/route";
import { getRenderPool } from "@/lib/mockup/render-pool";

afterAll(async () => {
  await getRenderPool().close();
});

const png = (w: number, h: number, rgb: [number, number, number]) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 },
    },
  })
    .png()
    .toBuffer();

function zipEntryNames(buf: Uint8Array): { name: string; head: number[] }[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const out: { name: string; head: number[] }[] = [];
  let o = 0;
  while (o + 4 <= buf.length && dv.getUint32(o, true) === 0x04034b50) {
    const compSize = dv.getUint32(o + 18, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    const name = dec.decode(buf.subarray(o + 30, o + 30 + nameLen));
    const dataStart = o + 30 + nameLen + extraLen;
    out.push({ name, head: [...buf.subarray(dataStart, dataStart + 3)] });
    o = dataStart + compSize;
  }
  return out;
}

function form(payload: unknown, files: { field: string; buf: Buffer; name: string }[]) {
  const fd = new FormData();
  for (const f of files) {
    fd.append(f.field, new Blob([new Uint8Array(f.buf)], { type: "image/png" }), f.name);
  }
  fd.append("payload", JSON.stringify(payload));
  return new Request("http://localhost/api/mockups/render", { method: "POST", body: fd });
}

describe("POST /api/mockups/render", () => {
  test("streams a ZIP of the rendered jobs", async () => {
    const mock = await png(160, 120, [100, 110, 120]);
    const design = await png(60, 60, [10, 210, 10]);

    const res = await POST(
      form(
        {
          format: "jpeg",
          targetMB: [0.02, 0.08],
          namePattern: "{design}_{mockup}",
          mockups: [
            {
              name: "shirt",
              width: 160,
              height: 120,
              calibration: {
                qs: [
                  [
                    [0.2, 0.2],
                    [0.8, 0.2],
                    [0.8, 0.8],
                    [0.2, 0.8],
                  ],
                ],
                shade: 15,
              },
            },
          ],
          designs: [{ name: "logo" }],
          jobs: [{ mockup: 0, design: 0 }, { mockup: 0, design: 0 }],
        },
        [
          { field: "mockup", buf: mock, name: "m0.png" },
          { field: "design", buf: design, name: "d0.png" },
        ],
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("mockups.zip");

    const buf = new Uint8Array(await res.arrayBuffer());
    const entries = zipEntryNames(buf);
    expect(entries.map((e) => e.name)).toEqual(["logo_shirt.jpg", "logo_shirt-2.jpg"]);
    for (const e of entries) expect(e.head).toEqual([0xff, 0xd8, 0xff]);

    // EOCD present, 2 entries
    const dv = new DataView(buf.buffer);
    const eocd = buf.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
  }, 30_000);

  test("401 when not connected", async () => {
    vi.mocked(getEtsySession).mockResolvedValueOnce(null);
    const res = await POST(
      form({ mockups: [], designs: [], jobs: [] }, []),
    );
    expect(res.status).toBe(401);
  });

  test("400 on an out-of-range job index", async () => {
    const mock = await png(20, 20, [0, 0, 0]);
    const res = await POST(
      form(
        { mockups: [{ name: "m", calibration: {} }], designs: [], jobs: [{ mockup: 5 }] },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );
    expect(res.status).toBe(400);
  });

  test("400 when payload.mockups count disagrees with the files", async () => {
    const mock = await png(20, 20, [0, 0, 0]);
    const res = await POST(
      form(
        { mockups: [], designs: [], jobs: [{ mockup: 0 }] },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );
    expect(res.status).toBe(400);
  });
});

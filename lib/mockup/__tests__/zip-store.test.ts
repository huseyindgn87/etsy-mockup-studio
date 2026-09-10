import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, test } from "vitest";
import { crc32, StoreZip } from "../zip-store";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("crc32", () => {
  test("matches the standard check value", () => {
    expect(crc32(ascii("123456789")) >>> 0).toBe(0xcbf43926);
  });

  test("matches node:zlib.crc32 on random data", () => {
    const buf = new Uint8Array(5000);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) & 0xff;
    expect(crc32(buf)).toBe(zlibCrc32(buf) >>> 0);
  });

  test("empty input is 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

/** Parse a STORE zip built by {@link StoreZip} back into { name, data }. */
function readStoreZip(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out: { name: string; data: Uint8Array }[] = [];
  let o = 0;
  while (o + 4 <= bytes.length && dv.getUint32(o, true) === 0x04034b50) {
    const method = dv.getUint16(o + 8, true);
    const crc = dv.getUint32(o + 14, true);
    const compSize = dv.getUint32(o + 18, true);
    const uncompSize = dv.getUint32(o + 22, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    expect(method).toBe(0); // STORE
    expect(compSize).toBe(uncompSize);
    const name = dec.decode(bytes.subarray(o + 30, o + 30 + nameLen));
    const dataStart = o + 30 + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data });
    o = dataStart + compSize;
  }
  // central directory follows
  expect(dv.getUint32(o, true)).toBe(0x02014b50);
  return out;
}

describe("StoreZip", () => {
  test("round-trips entries with correct names, bytes and EOCD", () => {
    const zip = new StoreZip();
    const a = ascii("hello world");
    const b = new Uint8Array([0, 1, 2, 250, 251, 255, 0, 128]);
    const chunks = [zip.file("a.txt", a), zip.file("nested/b.bin", b)];
    const tail = zip.end();

    let total = 0;
    for (const c of chunks) total += c.length;
    total += tail.length;
    const merged = new Uint8Array(total);
    let p = 0;
    for (const c of [...chunks, tail]) {
      merged.set(c, p);
      p += c.length;
    }

    const entries = readStoreZip(merged);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "nested/b.bin"]);
    expect(entries[0].data).toEqual(a);
    expect(entries[1].data).toEqual(b);

    // EOCD: last 22 bytes, entry count = 2
    const dv = new DataView(merged.buffer);
    const eocd = merged.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 8, true)).toBe(2);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
  });

  test("central-directory offsets point at each local header", () => {
    const zip = new StoreZip();
    const sizes = [10, 0, 37];
    let running = 0;
    const localOffsets: number[] = [];
    for (let i = 0; i < sizes.length; i++) {
      localOffsets.push(running);
      const chunk = zip.file(`f${i}`, new Uint8Array(sizes[i]).fill(i + 1));
      running += chunk.length;
    }
    const tail = zip.end();
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let o = 0;
    for (let i = 0; i < sizes.length; i++) {
      expect(dv.getUint32(o, true)).toBe(0x02014b50);
      const nameLen = dv.getUint16(o + 28, true);
      expect(dv.getUint32(o + 42, true)).toBe(localOffsets[i]);
      o += 46 + nameLen;
    }
  });

  test("end() twice throws; file() after end() throws", () => {
    const zip = new StoreZip();
    zip.file("x", ascii("x"));
    zip.end();
    expect(() => zip.end()).toThrow();
    expect(() => zip.file("y", ascii("y"))).toThrow();
  });
});

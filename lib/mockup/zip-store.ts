/**
 * Minimal streaming ZIP writer, STORE method (no compression).
 *
 * The batch renders are already-compressed JPEG/PNG, so DEFLATE would only burn
 * CPU for ~0 gain. Byte layout ported from `mockup-atolyesi.html`'s hand-rolled
 * `zip()` / `crc32()`. Not ZIP64: throws past 0xFFFF entries or a 4 GiB total.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION = 20;
const DOS_EPOCH_DATE = 0x21; // 1980-01-01, no time
const MAX_U32 = 0xffffffff;

interface CentralEntry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

/**
 * Incremental STORE-zip builder: {@link file} once per entry (each call returns
 * the bytes to stream out now), then {@link end} once for the central directory.
 */
export class StoreZip {
  private readonly enc = new TextEncoder();
  private readonly central: CentralEntry[] = [];
  private offset = 0;
  private ended = false;

  file(name: string, data: Uint8Array): Uint8Array {
    if (this.ended) throw new Error("StoreZip: file() after end()");
    if (this.central.length >= 0xffff) throw new Error("StoreZip: too many entries (ZIP64 unsupported)");
    const nameBytes = this.enc.encode(name);
    const localLen = 30 + nameBytes.length + data.length;
    if (this.offset + localLen > MAX_U32)
      throw new Error("StoreZip: archive exceeds 4 GiB (ZIP64 unsupported)");
    const crc = crc32(data);

    const out = new Uint8Array(30 + nameBytes.length + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, LOCAL_SIG, true);
    dv.setUint16(4, VERSION, true);
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, 0, true); // method: store
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, DOS_EPOCH_DATE, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true); // compressed size
    dv.setUint32(22, data.length, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra len
    out.set(nameBytes, 30);
    out.set(data, 30 + nameBytes.length);

    this.central.push({ name: nameBytes, crc, size: data.length, offset: this.offset });
    this.offset += out.length;
    return out;
  }

  end(): Uint8Array {
    if (this.ended) throw new Error("StoreZip: end() called twice");
    this.ended = true;

    const records: Uint8Array[] = [];
    let centralSize = 0;
    for (const e of this.central) {
      const rec = new Uint8Array(46 + e.name.length);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, CENTRAL_SIG, true);
      dv.setUint16(4, VERSION, true); // version made by
      dv.setUint16(6, VERSION, true); // version needed
      dv.setUint16(8, 0, true); // flags
      dv.setUint16(10, 0, true); // method: store
      dv.setUint16(12, 0, true); // mod time
      dv.setUint16(14, DOS_EPOCH_DATE, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.size, true);
      dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.name.length, true);
      dv.setUint16(30, 0, true); // extra
      dv.setUint16(32, 0, true); // comment
      dv.setUint16(34, 0, true); // disk number
      dv.setUint16(36, 0, true); // internal attrs
      dv.setUint32(38, 0, true); // external attrs
      dv.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      records.push(rec);
      centralSize += rec.length;
    }

    const eocd = new Uint8Array(22);
    const dv = new DataView(eocd.buffer);
    dv.setUint32(0, EOCD_SIG, true);
    dv.setUint16(4, 0, true); // this disk
    dv.setUint16(6, 0, true); // central dir start disk
    dv.setUint16(8, this.central.length, true);
    dv.setUint16(10, this.central.length, true);
    dv.setUint32(12, centralSize, true);
    dv.setUint32(16, this.offset, true);
    dv.setUint16(20, 0, true); // comment len
    records.push(eocd);

    let total = 0;
    for (const r of records) total += r.length;
    const merged = new Uint8Array(total);
    let o = 0;
    for (const r of records) {
      merged.set(r, o);
      o += r.length;
    }
    return merged;
  }
}

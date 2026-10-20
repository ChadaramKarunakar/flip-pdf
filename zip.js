// Minimal "store" (no compression) ZIP writer/reader, used for library backups.
// PDFs and JPEG covers are already compressed, so storing them is fine and keeps this tiny.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; }
function cat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// entries: [{ name: 'a/b.txt', data: Blob | Uint8Array | string }]
export async function makeZip(entries, onProgress) {
  const parts = [];
  const central = [];
  let offset = 0;
  let i = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const blob = e.data instanceof Blob ? e.data : new Blob([typeof e.data === 'string' ? enc.encode(e.data) : e.data]);
    const buf = new Uint8Array(await blob.arrayBuffer()); // temporary, freed after the CRC
    const crc = crc32(buf);
    const size = buf.length;
    const local = cat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
      u32(crc), u32(size), u32(size), u16(name.length), u16(0), name
    );
    parts.push(local, blob);
    central.push(cat(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
      u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), name
    ));
    offset += local.length + size;
    onProgress && onProgress(++i / entries.length);
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = cat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cdSize), u32(offset), u16(0));
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// Returns Map<name, Blob>. Only reads archives made by makeZip (stored, no ZIP64).
export async function readZip(blob) {
  const tailLen = Math.min(blob.size, 66000);
  const tail = new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer());
  const dv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('Not a valid backup file');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const cdv = new DataView(cd.buffer);
  const out = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cdv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt backup (central directory)');
    const method = cdv.getUint16(p + 10, true);
    const size = cdv.getUint32(p + 24, true);
    const nameLen = cdv.getUint16(p + 28, true);
    const extraLen = cdv.getUint16(p + 30, true);
    const commentLen = cdv.getUint16(p + 32, true);
    const localOff = cdv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error('Unsupported backup compression');
    const lh = new DataView(await blob.slice(localOff, localOff + 30).arrayBuffer());
    const start = localOff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    out.set(name, blob.slice(start, start + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

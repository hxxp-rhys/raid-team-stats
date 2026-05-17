/**
 * Minimal zero-dependency ZIP builder (STORE method — no compression).
 * Enough to bundle the addon + companion for one-click download without
 * pulling in an archiver dependency (which would force a container rebuild
 * on the dev VPS). Store-only zips are valid and unpack everywhere
 * (Windows Explorer, WoW, macOS, unzip).
 *
 * Server-only (uses Buffer).
 */

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!)! & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Buffer | string };

/** Build a STORE-method .zip in memory. `name` uses forward slashes. */
export function buildStoreZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01-ish)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir header sig
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0x21, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD sig
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

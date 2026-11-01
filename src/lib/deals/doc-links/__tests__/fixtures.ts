/** 合成バイト列(実画像は使わない)。作りは lp-asset-metadata-strip.test.ts と同じ。 */
function seg(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
const sof0 = (() => {
  const p = Buffer.alloc(9);
  p[0] = 8;
  p.writeUInt16BE(900, 1);
  p.writeUInt16BE(1600, 3);
  p[5] = 1;
  p[6] = 1; p[7] = 0x11; p[8] = 0;
  return seg(0xc0, p);
})();
const dht = (() => {
  const c = Buffer.alloc(16);
  c[0] = 1;
  return seg(0xc4, Buffer.concat([Buffer.from([0x00]), c, Buffer.alloc(1, 0x0a)]));
})();

export const DIRTY_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("II*\0\x08\0\0\0\0\0", "latin1")])),
  seg(0xfe, Buffer.from("撮影者 試験 太郎", "utf8")),
  seg(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 0x10)])),
  dht,
  sof0,
  seg(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
  Buffer.from([0x12, 0xff, 0x00, 0x34, 0x56, 0x78]),
  Buffer.from([0xff, 0xd9]),
]);

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = (() => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(800, 0);
  b.writeUInt32BE(600, 4);
  b[8] = 8; b[9] = 2;
  return chunk("IHDR", b);
})();
export const DIRTY_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ihdr,
  chunk("tEXt", Buffer.from("Comment\0GPS 35.0,139.0", "latin1")),
  chunk("IDAT", Buffer.from([0x78, 0x9c, 0x01, 0x00])),
  chunk("IEND", Buffer.alloc(0)),
]);

/**
 * 画像のヘッダから幅・高さを読む純関数(依存なし・Node Buffer のみ)。
 * LP用写真の上限(長辺1600px)をサーバー側でも検査するために使う。
 * 対応: JPEG(SOF0..SOF15 のうち寸法を持つもの)・PNG(IHDR)・WebP(VP8 / VP8L / VP8X)。
 * 読めない・対応外は null(例外は投げない=呼び出し側が 422 にする)。
 */
export interface ImageDimensions { width: number; height: number }

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    while (pos < buf.length && buf[pos] === 0xff) pos += 1;
    if (pos >= buf.length) return null;
    const marker = buf[pos];
    pos += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (pos + 2 > buf.length) return null;
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) return null;
    if (SOF_MARKERS.has(marker)) {
      if (len < 7) return null;
      const height = buf.readUInt16BE(pos + 3);
      const width = buf.readUInt16BE(pos + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    pos += len;
  }
  return null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function webp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    const width = buf.readUIntLE(24, 3) + 1;
    const height = buf.readUIntLE(27, 3) + 1;
    return { width, height };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (chunk === "VP8 ") {
    if (buf.length < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

export function readImageDimensions(buf: Buffer, mime: string): ImageDimensions | null {
  try {
    switch (mime.toLowerCase()) {
      case "image/jpeg": return jpeg(buf);
      case "image/png": return png(buf);
      case "image/webp": return webp(buf);
      default: return null;
    }
  } catch {
    return null;
  }
}

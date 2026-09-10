/**
 * LP用写真(公開口 `/lp-assets/<publicId>` で誰にでも配られる画像)から、
 * **デコードに要らないバイトを全て落とす**純関数(@codex R1 P1 対応・ruling R8(a))。
 *
 * 方針 = **許可リスト(allowlist)**。「危ないものを除く」条件式ではなく、
 * **安全と分かっているものだけを組み立て直す**(repo ルール redaction-allowlist-not-pattern)。
 * 既存の stripFieldSurveyPhotoMetadata は EXIF/XMP(JPEG APP1・PNG eXIf・WebP EXIF)
 * だけを狙って落とすため、JPEG の COM / APP0(JFIF) / APP13(IPTC) や
 * PNG の tEXt/zTXt/iTXt、WebP の XMP/ICCP が残る。公開配信する LP 用写真では
 * それらも残さない。
 *
 * 注意: **向き(Orientation)は保持しない**。既存の EXIF strip は Orientation だけを
 * 最小 Exif として再注入するが、本 utility はその APP1 も落とす。LP用写真は画面側の
 * canvas 変換で向きを焼き込んでから送るため(prepareLpAssetForUpload)、
 * メタデータ側の向き情報は不要。
 *
 * 依存なし(pure TypeScript + Node Buffer)。入力 buffer は mutate しない。例外は投げない
 * (内部で throw されても malformed に倒す = fail-closed)。
 */

export type LpAssetStripResult =
  | { ok: true; buffer: Buffer; changed: boolean }
  | { ok: false; reason: "unsupported_mime" | "malformed" };

const MALFORMED: LpAssetStripResult = { ok: false, reason: "malformed" };
const UNSUPPORTED: LpAssetStripResult = { ok: false, reason: "unsupported_mime" };

/**
 * LP用写真 1 枚分のバイト列から、デコードに不要なメタデータを全て取り除く。
 * 対応 MIME は image/jpeg / image/png / image/webp のみ(他は unsupported_mime)。
 * 構造が読み切れない入力は malformed(原本を通す fail-open にはしない)。
 */
export function stripLpAssetMetadata(buffer: Buffer, mime: string): LpAssetStripResult {
  try {
    switch (mime.toLowerCase()) {
      case "image/jpeg":
        return stripJpeg(buffer);
      case "image/png":
        return stripPng(buffer);
      case "image/webp":
        return stripWebp(buffer);
      default:
        return UNSUPPORTED;
    }
  } catch {
    return MALFORMED;
  }
}

function settle(input: Buffer, out: Buffer): LpAssetStripResult {
  return out.equals(input)
    ? { ok: true, buffer: input, changed: false }
    : { ok: true, buffer: out, changed: true };
}

// ---------------------------------------------------------------
// JPEG: デコードに要る marker だけを残す
// ---------------------------------------------------------------

/**
 * 残す marker(長さフィールドを持つ segment)。
 *   0xC0-0xCF = SOFn(フレームヘッダ) / 0xC4 DHT(ハフマン表) / 0xCC DAC(算術符号の条件)。
 *     ただし 0xC8 は JPG(予約・実運用で現れない)なので落とす。
 *   0xDB DQT(量子化表) / 0xDD DRI(リスタート間隔) / 0xDA SOS(スキャン開始)。
 * 落とすもの: APPn(0xE0-0xEF・JFIF APP0 と Exif APP1 を含む)・COM(0xFE)・
 *   JPGn(0xF0-0xFD)・DNL(0xDC)・その他未知の marker。
 *   APP0(JFIF) はデコードに不要(密度情報だけ)なので残さない。
 */
const JPEG_KEEP_SEGMENTS = new Set<number>([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
  0xdb, 0xdd, 0xda,
]);

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function stripJpeg(input: Buffer): LpAssetStripResult {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return MALFORMED;
  const kept: Buffer[] = [JPEG_SOI];
  let sawSos = false;
  let sawEoi = false;
  let pos = 2;
  while (pos < input.length) {
    if (input[pos] !== 0xff) return MALFORMED;
    while (pos < input.length && input[pos] === 0xff) pos += 1; // fill byte(0xFF の連続)は仕様上許容
    if (pos >= input.length) return MALFORMED;
    const markerPos = pos;
    const marker = input[markerPos];
    pos += 1;
    if (marker === 0xd9) { sawEoi = true; break; } // EOI
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue; // 長さを持たない marker。SOS より前に現れても意味が無いので落とす
    }
    if (pos + 2 > input.length) return MALFORMED;
    const segLen = input.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > input.length) return MALFORMED;
    const segEnd = pos + segLen;
    if (JPEG_KEEP_SEGMENTS.has(marker)) kept.push(input.subarray(markerPos - 1, segEnd));
    pos = segEnd;
    if (marker !== 0xda) continue;
    // SOS の後は entropy-coded data。0xFF00(スタッフ)・0xFFD0-D7(RSTn)・0xFF の連続以外の
    // 0xFFxx が次の marker = スキャンの終わり(progressive JPEG は複数スキャンを持つ)。
    sawSos = true;
    const scanStart = pos;
    while (pos < input.length) {
      if (input[pos] !== 0xff) { pos += 1; continue; }
      let p = pos + 1;
      while (p < input.length && input[p] === 0xff) p += 1;
      if (p >= input.length) return MALFORMED; // 0xFF で終わる = 構造不正
      const m = input[p];
      if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { pos = p + 1; continue; }
      break;
    }
    if (pos >= input.length) return MALFORMED; // EOI に届かない
    kept.push(input.subarray(scanStart, pos));
  }
  if (!sawSos || !sawEoi) return MALFORMED;
  kept.push(JPEG_EOI);
  return settle(input, Buffer.concat(kept));
}

// ---------------------------------------------------------------
// PNG: 表示に要る chunk だけを残す(chunk のバイトは CRC ごと原文のまま)
// ---------------------------------------------------------------

/**
 * 残す chunk。critical(IHDR/PLTE/IDAT/IEND)と、表示の見た目に効く安全な補助 chunk のみ。
 * 注意: `iCCP` は残さない。任意のバイト列(埋め込みプロファイル)を運べる器で、
 *   外して困る場面がほぼ無い(ブラウザは sRGB として描く)。
 *   tEXt/zTXt/iTXt/tIME/eXIf/未知 chunk も当然落とす。
 */
const PNG_KEEP_CHUNKS = new Set([
  "IHDR", "PLTE", "IDAT", "IEND",
  "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "pHYs", "bKGD", "hIST",
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stripPng(input: Buffer): LpAssetStripResult {
  if (input.length < PNG_SIGNATURE.length + 12) return MALFORMED;
  if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return MALFORMED;
  const kept: Buffer[] = [input.subarray(0, PNG_SIGNATURE.length)];
  let pos = PNG_SIGNATURE.length;
  let first = true;
  let sawIend = false;
  while (pos < input.length) {
    if (pos + 8 > input.length) return MALFORMED;
    const dataLen = input.readUInt32BE(pos);
    const chunkType = input.toString("latin1", pos + 4, pos + 8);
    const chunkEnd = pos + 8 + dataLen + 4; // length(4) + type(4) + data + CRC(4)
    if (dataLen > input.length || chunkEnd > input.length) return MALFORMED;
    if (first) {
      if (chunkType !== "IHDR") return MALFORMED;
      first = false;
    }
    if (PNG_KEEP_CHUNKS.has(chunkType)) kept.push(input.subarray(pos, chunkEnd));
    pos = chunkEnd;
    if (chunkType === "IEND") { sawIend = true; break; }
  }
  if (!sawIend) return MALFORMED;
  // IEND より後ろの余剰バイトは(あっても)落とす = 許可リストの外
  return settle(input, Buffer.concat(kept));
}

// ---------------------------------------------------------------
// WebP: 画像そのものの chunk だけを残す
// ---------------------------------------------------------------

/** 残す chunk。VP8 (lossy) / VP8L (lossless) / VP8X (拡張ヘッダ) / ALPH (透過) / ANIM・ANMF (アニメ)。 */
const WEBP_KEEP_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);

/** VP8X flags: ICC=0x20 / Alpha=0x10 / EXIF=0x08 / XMP=0x04 / Anim=0x02。 */
const VP8X_DROPPED_FLAGS = 0x20 | 0x08 | 0x04;

function stripWebp(input: Buffer): LpAssetStripResult {
  if (input.length < 12) return MALFORMED;
  if (input.toString("latin1", 0, 4) !== "RIFF") return MALFORMED;
  if (input.readUInt32LE(4) !== input.length - 8) return MALFORMED; // RIFF size は実長と厳密一致
  if (input.toString("latin1", 8, 12) !== "WEBP") return MALFORMED;
  const kept: Buffer[] = [];
  let pos = 12;
  let bodyLen = 0;
  let vp8xOffsetInBody = -1;
  while (pos < input.length) {
    if (pos + 8 > input.length) return MALFORMED;
    const fourcc = input.toString("latin1", pos, pos + 4);
    const dataLen = input.readUInt32LE(pos + 4);
    const paddedLen = dataLen + (dataLen % 2); // 奇数 size は 1 byte pad(RIFF 仕様)
    const chunkEnd = pos + 8 + paddedLen;
    if (dataLen > input.length || chunkEnd > input.length) return MALFORMED;
    if (WEBP_KEEP_CHUNKS.has(fourcc)) {
      if (fourcc === "VP8X" && dataLen >= 1) vp8xOffsetInBody = bodyLen;
      kept.push(input.subarray(pos, chunkEnd));
      bodyLen += chunkEnd - pos;
    }
    pos = chunkEnd;
  }
  const body = Buffer.concat(kept, bodyLen); // concat = 新規確保。入力は mutate されない
  if (vp8xOffsetInBody >= 0) {
    // ICC / EXIF / XMP の chunk を落としたので、拡張ヘッダの該当 flag も落とす
    // (fourcc 4 + size 4 の直後 = payload 先頭 1 byte が flags)
    body[vp8xOffsetInBody + 8] &= ~VP8X_DROPPED_FLAGS;
  }
  const out = Buffer.alloc(12 + bodyLen);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(4 + bodyLen, 4); // RIFF size = 全長 - 8
  out.write("WEBP", 8, "latin1");
  body.copy(out, 12);
  return settle(input, out);
}

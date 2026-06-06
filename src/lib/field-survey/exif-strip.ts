/**
 * field-survey 写真の EXIF / GPS メタデータ除去 pure utility。
 *
 * 位置づけ:
 *   docs/field-survey-photo-privacy-checklist.md §5 推奨候補 B0（route-level strip）の実装。
 *   PR #142 で POC（route 未接続）として追加し、**現在は field-survey photos route
 *   (src/app/api/field-survey/pins/[id]/photos/route.ts) の保存前処理として接続済み =
 *   本番アップロード経路の一部**。適用は同 route 限定で、PropertyPhoto / BuildingPhoto /
 *   attachments には適用しない（route test の source assertion でロック）。
 *
 * JPEG の方式（PR #144 Codex review 対応で変更）:
 *   - 旧方式（PR #142 POC）= GPS IFD のみ zero-fill は、GPS を含まない通常 EXIF
 *     （Make / Model / DateTime / シリアル / ExifIFD / MakerNote 等）をそのまま残すため
 *     「EXIF/GPS stripping」として不十分（Codex 指摘）。
 *   - 現方式 = **APP1 segment（Exif も XMP もすべて）を drop し、元 Exif の IFD0 から
 *     Orientation（0x0112・値 1〜8）だけ読めた場合に限り、Orientation 1 タグのみの
 *     最小 Exif APP1（固定テンプレート・little-endian）を SOI 直後に再注入**する。
 *     Make / Model / DateTime / GPS / ExifIFD / MakerNote / XMP は一切保持しない。
 *   - Orientation が無い / 値が 1〜8 でない / Exif 内部が解釈できない場合は再注入しない
 *     （APP1 は drop され、メタデータは何も残らない側に倒れる）。
 *
 * malformed 境界（fail-closed の対象）:
 *   - **JPEG の segment 構造**（SOI / 長さ付き segment / SOS）が検証できない入力は
 *     { ok: false, reason: "malformed" }（原本をそのまま通す fail-open を既定にしない）。
 *   - **Exif APP1 の内部**（TIFF 構造）の異常は malformed にしない。APP1 は丸ごと drop
 *     されるため、内部が壊れていても出力にメタデータは残らない（Orientation の
 *     再注入だけを諦める）。捨てる対象の異常でアップロードを拒否しない。
 *
 * 除去範囲と残余:
 *   - JPEG: APP1 全 drop（Exif / XMP とも）+ Orientation のみ最小再注入。
 *     APP0(JFIF) / DQT / SOF / コメント(COM) 等の非 APP1 segment は温存する。
 *     再注入 APP1 は SOI 直後に置く（Exif 仕様準拠。JFIF の「APP0 先頭」慣行とは
 *     順序が前後するが、デコーダ互換上の実害は無い）。
 *   - PNG: eXIf chunk drop / WebP: EXIF chunk drop（RIFF size 再計算 +
 *     VP8X ヘッダの EXIF flag clear 込み）。
 *   - 残余: WebP の XMP chunk・PNG の iTXt / tEXt 系テキスト・JPEG の APPn (n≠1) /
 *     COM(コメント) にベンダ・ユーザが書き込むメタデータ。
 *     docs §2 に残余として明記（「完全解消」ではない）。
 *   - HEIC / HEIF（ISOBMFF）: 依存追加なしで安全に解析できないため
 *     unsupported_mime を返す（field-survey photos route はこれを 422 にする = docs §6 決定済）。
 *
 * 依存: なし（pure TypeScript + Node Buffer のみ。sharp 等の未宣言 transitive 依存も
 * import しない）。入力 buffer は一切 mutate しない。バイト変更がある場合のみ新規 buffer を
 * 返す（changed=false のときは入力 buffer をそのまま返す）。
 */

export type ExifStripFailureReason = "unsupported_mime" | "malformed";

export type ExifStripResult =
  | { ok: true; buffer: Buffer; changed: boolean }
  | { ok: false; reason: ExifStripFailureReason };

const MALFORMED: ExifStripResult = { ok: false, reason: "malformed" };

/**
 * field-survey 写真 1 枚分のバイト列から EXIF / GPS メタデータを除去する。
 * 対応: image/jpeg（APP1 全 drop + Orientation のみ最小再注入）/
 * image/png（eXIf chunk drop）/ image/webp（EXIF chunk drop）。
 * image/heic・image/heif ほか未対応 MIME は unsupported_mime、構造不正は malformed を返す。
 */
export function stripFieldSurveyPhotoMetadata(
  buffer: Buffer,
  mimeType: string,
): ExifStripResult {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return stripJpegExif(buffer);
    case "image/png":
      return stripPngExif(buffer);
    case "image/webp":
      return stripWebpExif(buffer);
    default:
      // image/heic・image/heif を含む未対応 MIME。HEIC/HEIF は ISOBMFF の入れ子
      // box 構造（meta/iinf/iloc 経由の Exif item）で、依存追加なしの手書きパースは
      // 誤除去・見落としリスクが高いため対象外とする。
      return { ok: false, reason: "unsupported_mime" };
  }
}

// ---------------------------------------------------------------
// JPEG: APP1 segment を全て drop し、Orientation のみ最小 Exif として再注入する
// ---------------------------------------------------------------

const EXIF_APP1_HEADER = Buffer.from("Exif\0\0", "latin1");

const ORIENTATION_TAG = 0x0112;

/** IFD チェーン（IFD0 → IFD1 …）の走査上限。循環 offset への防御。 */
const MAX_IFD_CHAIN = 8;

function stripJpegExif(input: Buffer): ExifStripResult {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return MALFORMED;
  /** SOI の後・SOS の前に温存する segment 群（APP1 以外）。 */
  const kept: Buffer[] = [];
  /** SOS segment 以降（entropy-coded data + EOI）。無検証で丸ごと温存する。 */
  let tail: Buffer | null = null;
  let orientation: number | null = null;
  let droppedApp1 = 0;
  let pos = 2;
  while (pos < input.length) {
    if (input[pos] !== 0xff) return MALFORMED;
    const segHead = pos;
    // marker 直前の 0xFF fill byte は仕様上許容される（温存対象に含める）
    while (pos < input.length && input[pos] === 0xff) pos += 1;
    if (pos >= input.length) return MALFORMED;
    const marker = input[pos];
    pos += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(input.subarray(segHead, pos)); // 長さフィールドを持たない standalone marker
      continue;
    }
    if (marker === 0xd9) break; // SOS 前に EOI（tail=null のままなので下で malformed）
    if (pos + 2 > input.length) return MALFORMED;
    const segLen = input.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > input.length) return MALFORMED;
    const payloadStart = pos + 2;
    const segEnd = pos + segLen;
    if (marker === 0xda) {
      // SOS 以降は entropy-coded data（APPn はこれより前にしか現れない）。
      // 末尾の EOI 検証は行わない（実機 JPEG は EOI 後に余剰バイトを持つことがある）。
      tail = input.subarray(segHead);
      break;
    }
    if (marker === 0xe1) {
      // APP1 は Exif / XMP とも全て drop する（メタデータを出力に残さない）。
      // 最初に見つかった Exif APP1 から Orientation だけを best-effort で読む。
      droppedApp1 += 1;
      if (
        orientation === null &&
        segEnd - payloadStart >= EXIF_APP1_HEADER.length &&
        input
          .subarray(payloadStart, payloadStart + EXIF_APP1_HEADER.length)
          .equals(EXIF_APP1_HEADER)
      ) {
        orientation = readIfdOrientation(
          input,
          payloadStart + EXIF_APP1_HEADER.length,
          segEnd,
        );
      }
    } else {
      kept.push(input.subarray(segHead, segEnd));
    }
    pos = segEnd;
  }
  if (tail === null) return MALFORMED; // SOS 不達 = JPEG 構造として不正（fail-closed）
  if (droppedApp1 === 0) {
    return { ok: true, buffer: input, changed: false }; // APP1 が無ければ無変更
  }
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation !== null) {
    // Exif 仕様どおり SOI 直後に配置する（APP0 等の温存 segment より前で問題ない）
    parts.push(buildMinimalOrientationApp1(orientation));
  }
  parts.push(...kept, tail);
  const out = Buffer.concat(parts);
  if (out.equals(input)) {
    // 既に最小 Orientation APP1 のみ（= 本 utility の出力を再処理した場合等）は無変更扱い
    return { ok: true, buffer: input, changed: false };
  }
  return { ok: true, buffer: out, changed: true };
}

/**
 * Exif APP1 内 TIFF の IFD チェーンから Orientation（0x0112・SHORT×1・値 1〜8）を読む。
 * **best-effort**: 構造異常・値域外・不在は全て null（呼び出し側は再注入を諦めるだけで、
 * malformed にはしない。APP1 自体は drop されるため出力にメタデータは残らない）。
 */
function readIfdOrientation(
  input: Buffer,
  tiffStart: number,
  tiffEnd: number,
): number | null {
  if (tiffEnd - tiffStart < 8) return null;
  let littleEndian: boolean;
  if (input[tiffStart] === 0x49 && input[tiffStart + 1] === 0x49) {
    littleEndian = true; // "II"
  } else if (input[tiffStart] === 0x4d && input[tiffStart + 1] === 0x4d) {
    littleEndian = false; // "MM"
  } else {
    return null;
  }
  const readU16 = (off: number): number =>
    littleEndian ? input.readUInt16LE(off) : input.readUInt16BE(off);
  const readU32 = (off: number): number =>
    littleEndian ? input.readUInt32LE(off) : input.readUInt32BE(off);
  if (readU16(tiffStart + 2) !== 42) return null;
  const inBounds = (absStart: number, byteLen: number): boolean =>
    absStart >= tiffStart && byteLen >= 0 && absStart + byteLen <= tiffEnd;

  let ifdRel = readU32(tiffStart + 4);
  for (let chain = 0; chain < MAX_IFD_CHAIN && ifdRel !== 0; chain += 1) {
    const ifd = tiffStart + ifdRel;
    if (!inBounds(ifd, 2)) return null;
    const entryCount = readU16(ifd);
    const entriesStart = ifd + 2;
    if (!inBounds(entriesStart, entryCount * 12 + 4)) return null;
    for (let i = 0; i < entryCount; i += 1) {
      const entry = entriesStart + i * 12;
      if (readU16(entry) !== ORIENTATION_TAG) continue;
      // SHORT × 1 以外の Orientation は不正値として採用しない
      if (readU16(entry + 2) !== 3 || readU32(entry + 4) !== 1) return null;
      const value = readU16(entry + 8); // SHORT の inline 値は value field 先頭 2 byte
      return value >= 1 && value <= 8 ? value : null;
    }
    ifdRel = readU32(entriesStart + entryCount * 12); // next IFD（通常 Orientation は IFD0）
  }
  return null;
}

/**
 * Orientation 1 タグのみを含む最小 Exif APP1（固定テンプレート・little-endian）。
 * 構成: FF E1 + len(2) + "Exif\0\0" + TIFF header(8) + IFD0(count=1 + entry 12 + next 4)。
 * Make / Model / DateTime / GPS / ExifIFD / MakerNote は一切含めない。
 */
function buildMinimalOrientationApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(1, 8); // entry count = 1
  tiff.writeUInt16LE(ORIENTATION_TAG, 10); // entry: tag(2) + type(2) + count(4) + value(4)
  tiff.writeUInt16LE(3, 12); // type = SHORT
  tiff.writeUInt32LE(1, 14); // count = 1
  tiff.writeUInt16LE(orientation, 18); // inline 値は value field (offset 18) 先頭 2 byte
  tiff.writeUInt32LE(0, 22); // next IFD = 0
  const payloadLen = EXIF_APP1_HEADER.length + tiff.length; // 6 + 26 = 32
  const out = Buffer.alloc(4 + payloadLen); // marker(2) + len(2) + payload
  out[0] = 0xff;
  out[1] = 0xe1;
  out.writeUInt16BE(payloadLen + 2, 2); // len は自身の 2 byte を含む
  EXIF_APP1_HEADER.copy(out, 4);
  tiff.copy(out, 4 + EXIF_APP1_HEADER.length);
  return out;
}

// ---------------------------------------------------------------
// PNG: eXIf chunk を drop する（chunk 単位の削除なので他 chunk の CRC に影響しない）
// ---------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stripPngExif(input: Buffer): ExifStripResult {
  // 最小構成 = signature + IHDR(25) + IEND(12)
  if (input.length < PNG_SIGNATURE.length + 12) return MALFORMED;
  if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return MALFORMED;
  const kept: Buffer[] = [input.subarray(0, PNG_SIGNATURE.length)];
  let pos = PNG_SIGNATURE.length;
  let dropped = 0;
  let first = true;
  let sawIend = false;
  while (pos < input.length) {
    if (pos + 8 > input.length) return MALFORMED;
    const dataLen = input.readUInt32BE(pos);
    const chunkType = input.toString("latin1", pos + 4, pos + 8);
    const chunkEnd = pos + 8 + dataLen + 4; // length + type + data + CRC
    if (dataLen > input.length || chunkEnd > input.length) return MALFORMED;
    if (first) {
      if (chunkType !== "IHDR") return MALFORMED;
      first = false;
    }
    if (chunkType === "eXIf") {
      dropped += 1;
    } else {
      kept.push(input.subarray(pos, chunkEnd));
    }
    pos = chunkEnd;
    if (chunkType === "IEND") {
      sawIend = true;
      break;
    }
  }
  // IEND 欠落・IEND 後の余剰バイトは構造不正として弾く（fail-closed 前提）
  if (!sawIend || pos !== input.length) return MALFORMED;
  if (dropped === 0) return { ok: true, buffer: input, changed: false };
  return { ok: true, buffer: Buffer.concat(kept), changed: true };
}

// ---------------------------------------------------------------
// WebP: EXIF chunk を drop し RIFF size を再計算する
// ---------------------------------------------------------------

/** VP8X 拡張ヘッダ flags の EXIF bit（ICC=0x20 / Alpha=0x10 / EXIF=0x08 / XMP=0x04 / Anim=0x02）。 */
const VP8X_EXIF_FLAG = 0x08;

function stripWebpExif(input: Buffer): ExifStripResult {
  if (input.length < 12) return MALFORMED;
  if (input.toString("latin1", 0, 4) !== "RIFF") return MALFORMED;
  // RIFF size はファイル実長と厳密一致を要求（余剰バイトは fail-closed）
  if (input.readUInt32LE(4) !== input.length - 8) return MALFORMED;
  if (input.toString("latin1", 8, 12) !== "WEBP") return MALFORMED;
  const kept: Buffer[] = [];
  let pos = 12;
  let dropped = 0;
  let vp8xOffsetInBody = -1;
  let bodyLen = 0;
  while (pos < input.length) {
    if (pos + 8 > input.length) return MALFORMED;
    const fourcc = input.toString("latin1", pos, pos + 4);
    const dataLen = input.readUInt32LE(pos + 4);
    const paddedLen = dataLen + (dataLen % 2); // 奇数 size は 1 byte pad（RIFF 仕様）
    const chunkEnd = pos + 8 + paddedLen;
    if (dataLen > input.length || chunkEnd > input.length) return MALFORMED;
    if (fourcc === "EXIF") {
      dropped += 1;
    } else {
      if (fourcc === "VP8X" && dataLen >= 1) vp8xOffsetInBody = bodyLen;
      kept.push(input.subarray(pos, chunkEnd));
      bodyLen += chunkEnd - pos;
    }
    pos = chunkEnd;
  }
  if (dropped === 0) return { ok: true, buffer: input, changed: false };
  const body = Buffer.concat(kept, bodyLen); // concat は新規確保なので入力は mutate されない
  if (vp8xOffsetInBody >= 0) {
    // EXIF chunk を落としたので VP8X ヘッダ（fourcc 4 + size 4 の直後 = payload 先頭
    // 1 byte）の EXIF flag も clear し、ヘッダと実 chunk 構成の不整合を残さない
    body[vp8xOffsetInBody + 8] &= ~VP8X_EXIF_FLAG;
  }
  const out = Buffer.alloc(12 + bodyLen);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(4 + bodyLen, 4); // RIFF size 再計算（= 全長 - 8）
  out.write("WEBP", 8, "latin1");
  body.copy(out, 12);
  return { ok: true, buffer: out, changed: true };
}

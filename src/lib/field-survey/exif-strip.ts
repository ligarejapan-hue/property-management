/**
 * field-survey 写真の EXIF / GPS メタデータ除去 pure utility（POC・route 未接続）。
 *
 * 位置づけ:
 *   docs/field-survey-photo-privacy-checklist.md §5 推奨候補 B0（route-level strip）の
 *   前段 POC。**現時点ではどの route / storage からも import されておらず、本番の
 *   アップロード挙動と EXIF gap は未解消のまま**（接続は同 docs §6 の承認後・別 PR）。
 *
 * 方式評価（APP1 全 drop 案 vs GPS IFD 削除案）:
 *   - APP1 全 drop 案: 実装は容易だが Orientation タグ（0x0112）も消えるため、
 *     タグ回転前提のスマホ写真が横倒し表示になる回帰リスクが高く不採用。
 *   - GPS IFD 削除案（採用）: IFD0/IFD1 チェーンの GPSInfo ポインタ（0x8825）が指す
 *     GPS IFD とその out-of-line 値領域を**バイト位置を動かさず zero-fill** する。
 *     TIFF 内の絶対 offset を一切移動しないため、Orientation / ExifIFD 等の他構造を
 *     壊さない（= Orientation は保持される）。エントリの物理削除（バイト詰め）は
 *     全 offset の再計算が必要で危険なため行わない。
 *
 * 除去範囲と残余（**完全解消ではない**）:
 *   - 除去: JPEG = Exif APP1 内 GPS IFD（entry count / entries / next pointer と
 *     out-of-line 値を zero-fill。IFD0 側の 0x8825 エントリ自体は「空 IFD への参照」
 *     として残る = タグ ID のみで GPS 値は一切持たない）
 *     / PNG = eXIf chunk drop / WebP = EXIF chunk drop（RIFF size 再計算 +
 *     VP8X ヘッダの EXIF flag clear 込み）
 *   - 残余: Exif 内 MakerNote（ベンダ独自領域に位置情報が含まれ得る）・XMP
 *     （JPEG の非 Exif APP1 / WebP の XMP chunk / PNG の iTXt）・PNG の tEXt 系キー。
 *     これらは本 POC では対象外（route 接続 PR 以降の拡張候補）。
 *   - HEIC / HEIF（ISOBMFF）: 依存追加なしで安全に解析できないため
 *     unsupported_mime を返す（route 側で 422 にするかは次 PR の判断）。
 *
 * 失敗時の設計（fail-closed 前提）:
 *   - 構造が検証できない入力は { ok: false, reason: "malformed" } を返し、
 *     原本をそのまま通す fail-open を呼び出し側の既定にしない（silent gap 防止）。
 *   - 入力 buffer は一切 mutate しない。バイト変更がある場合のみ copy を返す
 *     （changed=false のときは入力 buffer をそのまま返す）。
 *
 * 依存: なし（pure TypeScript + Node Buffer のみ。sharp 等の未宣言 transitive 依存も
 * import しない）。
 */

export type ExifStripFailureReason = "unsupported_mime" | "malformed";

export type ExifStripResult =
  | { ok: true; buffer: Buffer; changed: boolean }
  | { ok: false; reason: ExifStripFailureReason };

const MALFORMED: ExifStripResult = { ok: false, reason: "malformed" };

/**
 * field-survey 写真 1 枚分のバイト列から GPS / EXIF メタデータを除去する。
 * 対応: image/jpeg（GPS IFD zero-fill）/ image/png（eXIf chunk drop）/
 * image/webp（EXIF chunk drop）。image/heic・image/heif ほか未対応 MIME は
 * unsupported_mime、構造不正は malformed を返す。
 */
export function stripFieldSurveyPhotoMetadata(
  buffer: Buffer,
  mimeType: string,
): ExifStripResult {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return stripJpegGps(buffer);
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
// JPEG: Exif APP1 内の GPS IFD を offset を動かさず zero-fill する
// ---------------------------------------------------------------

const EXIF_APP1_HEADER = Buffer.from("Exif\0\0", "latin1");

/** TIFF フィールド型ごとの 1 要素のバイト幅（EXIF/TIFF 6.0 の型 1..12。不明型は malformed）。 */
const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

const GPS_IFD_POINTER_TAG = 0x8825;

/** IFD チェーン（IFD0 → IFD1 …）の走査上限。循環 offset への防御。 */
const MAX_IFD_CHAIN = 8;

function stripJpegGps(input: Buffer): ExifStripResult {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return MALFORMED;
  let out: Buffer | null = null;
  let pos = 2;
  let sawSos = false;
  while (pos < input.length) {
    if (input[pos] !== 0xff) return MALFORMED;
    // marker 直前の 0xFF fill byte は仕様上許容される
    while (pos < input.length && input[pos] === 0xff) pos += 1;
    if (pos >= input.length) return MALFORMED;
    const marker = input[pos];
    pos += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue; // 長さフィールドを持たない standalone marker
    }
    if (marker === 0xd9) break; // SOS 前に EOI（sawSos=false のままなら下で malformed）
    if (pos + 2 > input.length) return MALFORMED;
    const segLen = input.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > input.length) return MALFORMED;
    const payloadStart = pos + 2;
    const segEnd = pos + segLen;
    if (marker === 0xda) {
      // SOS 以降は entropy-coded data（APPn はこれより前にしか現れない）。
      // 末尾の EOI 検証は行わない（実機 JPEG は EOI 後に余剰バイトを持つことがある）。
      sawSos = true;
      break;
    }
    if (
      marker === 0xe1 &&
      segEnd - payloadStart >= EXIF_APP1_HEADER.length &&
      input
        .subarray(payloadStart, payloadStart + EXIF_APP1_HEADER.length)
        .equals(EXIF_APP1_HEADER)
    ) {
      // Exif APP1 のみ対象。XMP 等の非 Exif APP1 は素通し（残余としてファイル先頭に明記）。
      const zeroed = zeroGpsInTiff(input, out, payloadStart + EXIF_APP1_HEADER.length, segEnd);
      if (!zeroed.ok) return MALFORMED;
      out = zeroed.out;
    }
    pos = segEnd;
  }
  if (!sawSos) return MALFORMED;
  if (out === null || out.equals(input)) {
    return { ok: true, buffer: input, changed: false };
  }
  return { ok: true, buffer: out, changed: true };
}

function zeroGpsInTiff(
  input: Buffer,
  existing: Buffer | null,
  tiffStart: number,
  tiffEnd: number,
): { ok: true; out: Buffer | null } | { ok: false } {
  if (tiffEnd - tiffStart < 8) return { ok: false };
  let littleEndian: boolean;
  if (input[tiffStart] === 0x49 && input[tiffStart + 1] === 0x49) {
    littleEndian = true; // "II"
  } else if (input[tiffStart] === 0x4d && input[tiffStart + 1] === 0x4d) {
    littleEndian = false; // "MM"
  } else {
    return { ok: false };
  }
  const readU16 = (off: number): number =>
    littleEndian ? input.readUInt16LE(off) : input.readUInt16BE(off);
  const readU32 = (off: number): number =>
    littleEndian ? input.readUInt32LE(off) : input.readUInt32BE(off);
  if (readU16(tiffStart + 2) !== 42) return { ok: false };

  /** absStart から byteLen バイトが APP1 segment（TIFF 領域）内に収まるか。 */
  const inBounds = (absStart: number, byteLen: number): boolean =>
    absStart >= tiffStart && byteLen >= 0 && absStart + byteLen <= tiffEnd;

  // 書き込み予定領域を全て検証してから zero-fill する（途中失敗で半端な出力を作らない）。
  const zeroRanges: Array<{ start: number; end: number }> = [];

  let ifdRel = readU32(tiffStart + 4);
  for (let chain = 0; chain < MAX_IFD_CHAIN && ifdRel !== 0; chain += 1) {
    const ifd = tiffStart + ifdRel;
    if (!inBounds(ifd, 2)) return { ok: false };
    const entryCount = readU16(ifd);
    const entriesStart = ifd + 2;
    if (!inBounds(entriesStart, entryCount * 12 + 4)) return { ok: false };
    for (let i = 0; i < entryCount; i += 1) {
      const entry = entriesStart + i * 12;
      if (readU16(entry) !== GPS_IFD_POINTER_TAG) continue;
      // GPSInfo ポインタは LONG × 1 が仕様。それ以外は構造不正として弾く
      if (readU16(entry + 2) !== 4 || readU32(entry + 4) !== 1) return { ok: false };
      const gpsIfd = tiffStart + readU32(entry + 8);
      if (!inBounds(gpsIfd, 2)) return { ok: false };
      const gpsCount = readU16(gpsIfd);
      const gpsEntriesStart = gpsIfd + 2;
      if (!inBounds(gpsEntriesStart, gpsCount * 12 + 4)) return { ok: false };
      for (let j = 0; j < gpsCount; j += 1) {
        const gpsEntry = gpsEntriesStart + j * 12;
        const typeSize = TIFF_TYPE_SIZE[readU16(gpsEntry + 2)];
        if (typeSize === undefined) return { ok: false };
        const valueLen = typeSize * readU32(gpsEntry + 4);
        if (valueLen > 4) {
          // 4 byte 超の値は out-of-line（offset 参照）。値の実体も zero-fill 対象
          const valueAbs = tiffStart + readU32(gpsEntry + 8);
          if (!inBounds(valueAbs, valueLen)) return { ok: false };
          zeroRanges.push({ start: valueAbs, end: valueAbs + valueLen });
        }
      }
      // GPS IFD 本体（entry count / entries / next-IFD pointer）を zero-fill。
      // count=0 の「空 IFD」として残り、IFD0 側の 0x8825 エントリは温存される
      // （offset を動かせないため。タグ ID のみ残り GPS 値は一切持たない）。
      zeroRanges.push({ start: gpsIfd, end: gpsEntriesStart + gpsCount * 12 + 4 });
    }
    // next IFD（IFD1 = サムネイル等）もチェーンで確認する
    ifdRel = readU32(entriesStart + entryCount * 12);
  }

  if (zeroRanges.length === 0) return { ok: true, out: existing };
  const out = existing ?? Buffer.from(input);
  for (const range of zeroRanges) {
    out.fill(0, range.start, range.end);
  }
  return { ok: true, out };
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

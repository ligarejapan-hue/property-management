/**
 * LP用写真(公開口 `/lp-assets/<publicId>` で誰にでも配られる画像)から、
 * **デコードに要らないバイトを全て落とす**純関数(@codex R1 P1 対応・ruling R8(a) / R9(3))。
 *
 * 方針 = **許可リスト(allowlist)**。「危ないものを除く」条件式ではなく、
 * **安全と分かっているものだけを組み立て直す**(repo ルール redaction-allowlist-not-pattern)。
 * 既存の stripFieldSurveyPhotoMetadata は EXIF/XMP(JPEG APP1・PNG eXIf・WebP EXIF)
 * だけを狙って落とすため、JPEG の COM / APP0(JFIF) / APP13(IPTC) や
 * PNG の tEXt/zTXt/iTXt、WebP の XMP/ICCP が残る。公開配信する LP 用写真では
 * それらも残さない。
 *
 * ⚠**残す器の中身も検査する**(ruling R9(3))。許可リストに入っている chunk / segment でも
 * 長さが仕様どおりでなければ、余ったバイトに任意の情報を隠せる(= 許可リストが嘘になる)。
 * そこで固定長の PNG chunk は長さを、JPEG の SOFn/DQT/DHT/DAC/DRI/DNL/SOS は内部構造を
 * ぴったり使い切るかまで確かめ、合わなければ malformed に倒す。
 * WebP は**アニメーション(ANIM/ANMF chunk・VP8X の Anim flag)を受け付けない**
 * (ANMF は subchunk を入れ子で持てるため抜け道になる。画面側は静止 JPEG しか作らない)。
 *
 * ⚠**構造の完全性(実データの有無)も検査する**(@codex P2)。器の形が仕様どおりでも、
 * **画素そのものが無い**(PNG が IHDR の直後 IEND だけ・JPEG が SOS はあるが
 * entropy-coded data が0byte 等)入力は寸法だけ読めてしまい、ブラウザがデコードできない
 * まま保存・配信されてしまう。そこで:
 *   - PNG: `IDAT` chunk を最低1つ・合計 payload 長 > 0 を必須にし、colour type=3
 *     (インデックスカラー)なら最初の `IDAT` より前に `PLTE` を必須にする。IHDR の
 *     幅/高さ/bit depth/colour type/compression/filter/interlace も仕様の値域か確かめる。
 *     **残す chunk 全ての CRC32**(type+data・多項式 0xEDB88320)も検算し、合わなければ
 *     malformed に倒す(CRC を検証しない = 中身を丸ごとすり替えられても気づけない)。
 *   - JPEG: `DQT` を最低1つ・`DHT`/`DAC` を最低1つ・最初の `SOS` の前に `SOFn` を
 *     必須にし、SOFn の幅/高さ>0 を検査、`SOS` 開始から `EOI` までの
 *     entropy-coded data が1byte 以上あることを確かめる。
 *   - WebP: `VP8 `/`VP8L` のどちらか**ちょうど1つ**を必須にする(両方/どちらも
 *     無しは malformed)。`VP8 ` は payload≥10byte かつ key-frame start code
 *     (bytes[3..5] = 0x9d 0x01 0x2a)、`VP8L` は payload≥5byte かつ byte[0]=0x2f を
 *     検査し、`VP8X` があれば先頭 chunk であることも必須にする。
 *
 * 注意: **向き(Orientation)は保持しない**。既存の EXIF strip は Orientation だけを
 * 最小 Exif として再注入するが、本 utility はその APP1 も落とす。LP用写真は画面側が
 * **必ず** canvas で再エンコードして向きを画素に焼き込んでから送るため
 * (prepareLpAssetForUpload = 無変換で送る道は無い)、メタデータ側の向き情報は要らない。
 *
 * 注意: **PNG の透過情報(sBIT/bKGD/hIST/tRNS)は保持しない**(@codex P2)。これらは
 * colour type ごとに厳密な固定長を持つ(例: greyscale の sBIT は1byte・greyscale の tRNS は
 * 2byte)ため、colour type に応じた個別の長さ検査を持たない範囲チェックのままでは余りバイトを
 * 隠せる/不正な chunk を通せてしまう。そこで PNG の残す chunk は
 * `IHDR/PLTE/IDAT/IEND/gAMA(4)/cHRM(32)/sRGB(1)/pHYs(9)`(全て固定長または構造で決まる)
 * のみとし、sBIT/bKGD/hIST/tRNS は他の未知 chunk と同じく落とす。direct API 経由の PNG は
 * 透過を失うが、画面(UI)経由の LP用写真は**必ず** JPEG に再エンコードされる
 * (JPEG に透過は無い)ため実害はない。
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
 *   0xDB DQT(量子化表) / 0xDC DNL(スキャン後の行数) / 0xDD DRI(リスタート間隔) /
 *   0xDA SOS(スキャン開始)。
 * 落とすもの: APPn(0xE0-0xEF・JFIF APP0 と Exif APP1 を含む)・COM(0xFE)・
 *   JPGn(0xF0-0xFD)・その他未知の marker。
 *   APP0(JFIF) はデコードに不要(密度情報だけ)なので残さない。
 */
const JPEG_KEEP_SEGMENTS = new Set<number>([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
  0xdb, 0xdc, 0xdd, 0xda,
]);

/** SOFn = 0xC0-0xCF から DHT(0xC4)・JPG(0xC8)・DAC(0xCC)を除いたもの。 */
function isJpegSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * 残す segment の payload(長さフィールドの後ろ)が仕様どおりかを確かめる。
 * ぴったり使い切らないものは、余白に任意の情報を隠せる器なので false(= malformed)。
 */
function jpegPayloadOk(marker: number, payload: Buffer): boolean {
  if (isJpegSof(marker)) {
    // precision(1) + height(2) + width(2) + Nf(1) + 成分ごとに 3 byte
    if (payload.length < 6) return false;
    const height = payload.readUInt16BE(1);
    const width = payload.readUInt16BE(3);
    if (width === 0 || height === 0) return false; // 実データの無い(0x0)画像は弾く
    const nf = payload[5];
    return nf >= 1 && nf <= 4 && payload.length === 6 + 3 * nf;
  }
  switch (marker) {
    case 0xdb: {
      // DQT: (Pq/Tq 1byte + 8bit なら 64 / 16bit なら 128) の並び
      let p = 0;
      while (p < payload.length) {
        const pq = payload[p] >> 4;
        if (pq > 1) return false;
        p += 1 + (pq === 0 ? 64 : 128);
      }
      return payload.length > 0 && p === payload.length;
    }
    case 0xc4: {
      // DHT: (Tc/Th 1byte + 符号長ごとの個数 16byte + 個数の合計ぶんの値) の並び
      let p = 0;
      while (p < payload.length) {
        if (p + 17 > payload.length) return false;
        let total = 0;
        for (let i = 1; i <= 16; i += 1) total += payload[p + i];
        p += 17 + total;
      }
      return payload.length > 0 && p === payload.length;
    }
    case 0xcc:
      // DAC: (Tc/Tb 1byte + Cs 1byte) の並び
      return payload.length > 0 && payload.length % 2 === 0;
    case 0xdd:
      // DRI: リスタート間隔(2) = segment 長 4
      return payload.length === 2;
    case 0xdc:
      // DNL: 行数(2) = segment 長 4
      return payload.length === 2;
    case 0xda: {
      // SOS: Ns(1) + 成分ごとに 2 byte + Ss/Se/AhAl(3)
      if (payload.length < 1) return false;
      const ns = payload[0];
      return ns >= 1 && ns <= 4 && payload.length === 1 + 2 * ns + 3;
    }
    default:
      return false; // 許可リストの marker はここに来ない(来たら fail-closed)
  }
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function stripJpeg(input: Buffer): LpAssetStripResult {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return MALFORMED;
  const kept: Buffer[] = [JPEG_SOI];
  let sawSos = false;
  let sawEoi = false;
  let sawSof = false; // 最初の SOS より前に SOFn を見たか(無いと寸法もデコードも決まらない)
  let sawDqt = false;
  let sawDhtOrDac = false;
  let entropyBytes = 0; // 最初の SOS 〜 EOI の entropy-coded data の合計(0 = 画素データ無し)
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
    if (marker === 0xda && !sawSof) return MALFORMED; // SOS の前に SOFn が無い = 寸法が決まらない
    if (JPEG_KEEP_SEGMENTS.has(marker)) {
      // 残す segment は中身の長さまで検査する(余ったバイトに情報を隠せないように)
      if (!jpegPayloadOk(marker, input.subarray(pos + 2, segEnd))) return MALFORMED;
      if (isJpegSof(marker)) sawSof = true;
      if (marker === 0xdb) sawDqt = true;
      if (marker === 0xc4 || marker === 0xcc) sawDhtOrDac = true;
      kept.push(input.subarray(markerPos - 1, segEnd));
    }
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
    entropyBytes += pos - scanStart;
    kept.push(input.subarray(scanStart, pos));
  }
  if (!sawSos || !sawEoi || !sawDqt || !sawDhtOrDac) return MALFORMED;
  if (entropyBytes <= 0) return MALFORMED; // SOS はあるが画素データが無い(@codex P2)
  kept.push(JPEG_EOI);
  return settle(input, Buffer.concat(kept));
}

// ---------------------------------------------------------------
// PNG: 表示に要る chunk だけを残す(chunk のバイトは CRC ごと原文のまま)
// ---------------------------------------------------------------

/**
 * 残す chunk。critical(IHDR/PLTE/IDAT/IEND)と、固定長または構造で決まる安全な補助 chunk
 * (gAMA/cHRM/sRGB/pHYs)のみ。
 * 注意: `iCCP` は残さない。任意のバイト列(埋め込みプロファイル)を運べる器で、
 *   外して困る場面がほぼ無い(ブラウザは sRGB として描く)。
 *   tEXt/zTXt/iTXt/tIME/eXIf/未知 chunk も当然落とす。
 * ⚠`sBIT`/`bKGD`/`hIST`/`tRNS` は**残さない**(@codex P2)。これらは colour type ごとに
 *   厳密な固定長(例: greyscale の sBIT は1byte・greyscale の tRNS は2byte)を持つが、
 *   colour type に応じた個別の長さ検査を持たない範囲チェックのままでは余りバイトを
 *   隠せる/不正な chunk を通せる。LP用写真の UI 経路は必ず JPEG に再エンコードされ
 *   (透過を持たない)、direct API 経由の PNG でだけ透過情報を失うが許容する。
 */
const PNG_KEEP_CHUNKS = new Set([
  "IHDR", "PLTE", "IDAT", "IEND",
  "gAMA", "cHRM", "sRGB", "pHYs",
]);

/** 長さが1通りしかない chunk(それ以外の長さ = 余りバイトを運べる器)。 */
const PNG_FIXED_LENGTHS: Record<string, number> = {
  IHDR: 13,
  gAMA: 4,
  cHRM: 32,
  sRGB: 1,
  pHYs: 9,
  IEND: 0,
};

/** 残す chunk の payload 長が仕様どおりか(画素そのものの IDAT・パレットの PLTE だけは可変長)。 */
function pngChunkLengthOk(chunkType: string, dataLen: number): boolean {
  const fixed = PNG_FIXED_LENGTHS[chunkType];
  if (fixed !== undefined) return dataLen === fixed;
  switch (chunkType) {
    case "IDAT": return true;
    // PLTE: 1〜256 エントリ(1エントリ = RGB 3byte)。0エントリ(空)は malformed。
    case "PLTE": return dataLen >= 3 && dataLen <= 768 && dataLen % 3 === 0;
    default: return false; // 許可リストの chunk はここに来ない(来たら fail-closed)
  }
}

/** IHDR(13byte 固定): 幅(4)+高さ(4)+bit depth(1)+colour type(1)+compression(1)+filter(1)+interlace(1)。 */
function pngIhdrOk(data: Buffer): boolean {
  if (data.length !== 13) return false;
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colourType = data[9];
  const compression = data[10];
  const filter = data[11];
  const interlace = data[12];
  if (width === 0 || height === 0) return false; // 実データの無い(0x0)画像は弾く
  if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8 && bitDepth !== 16) return false;
  if (colourType !== 0 && colourType !== 2 && colourType !== 3 && colourType !== 4 && colourType !== 6) return false;
  if (compression !== 0) return false;
  if (filter !== 0) return false;
  if (interlace !== 0 && interlace !== 1) return false;
  return true;
}

/**
 * PNG chunk の CRC32(仕様: type+data に対する CRC・多項式 0xEDB88320・zlib と同じ表)。
 * **残す chunk のバイトが本当に元のままか**(中身をすり替えられていないか)を確かめるために使う
 * (@codex P2)。標準 CRC32 の実装であり、本 utility の他の検査ロジックとは独立。
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stripPng(input: Buffer): LpAssetStripResult {
  if (input.length < PNG_SIGNATURE.length + 12) return MALFORMED;
  if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return MALFORMED;
  const kept: Buffer[] = [input.subarray(0, PNG_SIGNATURE.length)];
  let pos = PNG_SIGNATURE.length;
  let first = true;
  let sawIend = false;
  let colourType = -1;
  let idatTotalLen = 0;
  let sawIdat = false;
  let sawPlte = false;
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
    if (PNG_KEEP_CHUNKS.has(chunkType)) {
      // 残す chunk は長さまで検査する(余ったバイトに情報を隠せないように)
      if (!pngChunkLengthOk(chunkType, dataLen)) return MALFORMED;
      const data = input.subarray(pos + 8, pos + 8 + dataLen);
      if (chunkType === "IHDR") {
        if (!pngIhdrOk(data)) return MALFORMED;
        colourType = data[9];
      }
      if (chunkType === "PLTE") {
        if (sawIdat) return MALFORMED; // PLTE は最初の IDAT より前でなければならない
        if (colourType === 0 || colourType === 4) return MALFORMED; // greyscale 系に PLTE は現れない(@codex P2)
        sawPlte = true;
      }
      if (chunkType === "IDAT") {
        sawIdat = true;
        idatTotalLen += dataLen;
      }
      // 残す chunk は CRC32(type+data)も検算する(中身がすり替えられていないか)
      const storedCrc = input.readUInt32BE(chunkEnd - 4);
      if (crc32(input.subarray(pos + 4, pos + 8 + dataLen)) !== storedCrc) return MALFORMED;
      kept.push(input.subarray(pos, chunkEnd));
    }
    pos = chunkEnd;
    if (chunkType === "IEND") { sawIend = true; break; }
  }
  if (!sawIend) return MALFORMED;
  if (idatTotalLen <= 0) return MALFORMED; // 画素データ(IDAT)が無い(@codex P2)
  if (colourType === 3 && !sawPlte) return MALFORMED; // インデックスカラーは PLTE が必須
  // IEND より後ろの余剰バイトは(あっても)落とす = 許可リストの外
  return settle(input, Buffer.concat(kept));
}

// ---------------------------------------------------------------
// WebP: 画像そのものの chunk だけを残す(アニメーションは受け付けない)
// ---------------------------------------------------------------

/** 残す chunk。VP8 (lossy) / VP8L (lossless) / VP8X (拡張ヘッダ) / ALPH (透過)。 */
const WEBP_KEEP_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH"]);

/**
 * アニメーションの chunk。ANMF は中に subchunk を入れ子で持てるため、丸ごと残すと
 * 入れ子側にメタデータを積める(= 許可リストが嘘になる)。画面側は静止 JPEG しか
 * 作らないので、見つけたら malformed に倒す。
 */
const WEBP_ANIMATION_CHUNKS = new Set(["ANIM", "ANMF"]);

/** VP8X flags: ICC=0x20 / Alpha=0x10 / EXIF=0x08 / XMP=0x04 / Anim=0x02。 */
const VP8X_DROPPED_FLAGS = 0x20 | 0x08 | 0x04;
const VP8X_ANIMATION_FLAG = 0x02;
/** VP8X payload = flags(1) + reserved(3) + canvas幅-1(3) + canvas高-1(3)。 */
const VP8X_PAYLOAD_LEN = 10;

/** VP8(lossy) key-frame start code(payload bytes[3..5])。RFC 6386 §9.1。 */
const VP8_START_CODE = [0x9d, 0x01, 0x2a];
/** VP8(lossy) の最小 payload 長 = frame tag(3) + start code(3) + 幅/高さ(4)。 */
const VP8_MIN_PAYLOAD_LEN = 10;
/** VP8L(lossless) の signature byte(payload[0])。 */
const VP8L_SIGNATURE = 0x2f;
/** VP8L の最小 payload 長 = signature(1) + 幅/高さ/alpha/version(4 の一部)。 */
const VP8L_MIN_PAYLOAD_LEN = 5;

function stripWebp(input: Buffer): LpAssetStripResult {
  if (input.length < 12) return MALFORMED;
  if (input.toString("latin1", 0, 4) !== "RIFF") return MALFORMED;
  if (input.readUInt32LE(4) !== input.length - 8) return MALFORMED; // RIFF size は実長と厳密一致
  if (input.toString("latin1", 8, 12) !== "WEBP") return MALFORMED;
  const kept: Buffer[] = [];
  let pos = 12;
  let bodyLen = 0;
  let vp8xOffsetInBody = -1;
  let chunkIndex = 0;
  let sawVp8 = false;
  let sawVp8l = false;
  while (pos < input.length) {
    if (pos + 8 > input.length) return MALFORMED;
    const fourcc = input.toString("latin1", pos, pos + 4);
    const dataLen = input.readUInt32LE(pos + 4);
    const paddedLen = dataLen + (dataLen % 2); // 奇数 size は 1 byte pad(RIFF 仕様)
    const chunkEnd = pos + 8 + paddedLen;
    if (dataLen > input.length || chunkEnd > input.length) return MALFORMED;
    if (WEBP_ANIMATION_CHUNKS.has(fourcc)) return MALFORMED; // アニメーションは受け付けない
    if (fourcc === "VP8X" && chunkIndex !== 0) return MALFORMED; // VP8X は先頭 chunk でなければならない
    if (fourcc === "VP8 ") {
      // key-frame の frame tag(3byte)+ start code(3byte)+ 幅/高さ(4byte)を最低限持つか
      if (dataLen < VP8_MIN_PAYLOAD_LEN) return MALFORMED;
      const s0 = input[pos + 8 + 3], s1 = input[pos + 8 + 4], s2 = input[pos + 8 + 5];
      if (s0 !== VP8_START_CODE[0] || s1 !== VP8_START_CODE[1] || s2 !== VP8_START_CODE[2]) return MALFORMED;
      sawVp8 = true;
    }
    if (fourcc === "VP8L") {
      if (dataLen < VP8L_MIN_PAYLOAD_LEN) return MALFORMED;
      if (input[pos + 8] !== VP8L_SIGNATURE) return MALFORMED;
      sawVp8l = true;
    }
    if (WEBP_KEEP_CHUNKS.has(fourcc)) {
      if (fourcc === "VP8X") {
        if (dataLen !== VP8X_PAYLOAD_LEN) return MALFORMED;
        if ((input[pos + 8] & VP8X_ANIMATION_FLAG) !== 0) return MALFORMED; // Anim flag もアニメ扱い
        vp8xOffsetInBody = bodyLen;
      }
      kept.push(input.subarray(pos, chunkEnd));
      bodyLen += chunkEnd - pos;
    }
    pos = chunkEnd;
    chunkIndex += 1;
  }
  // 画像そのもの(VP8 か VP8L)がちょうど1つ無いと表示できない(@codex P2: 無い/両方は malformed)
  if (sawVp8 === sawVp8l) return MALFORMED;
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

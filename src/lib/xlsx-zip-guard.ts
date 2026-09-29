/**
 * Excel(.xlsx = ZIP)を読む前に、**展開後の大きさ**を上限で抑える。
 *
 * ⚠圧縮後のサイズ(取込共通の10MB)を見ても守りにならない。繰り返しの多い中身は
 *   数百分の一に縮むので、10MB 未満のファイルが数百MB〜数GBに膨らむ
 *   (いわゆる ZIP 爆弾)。xlsx の読み取り(XLSX.read)は中身を丸ごと展開してから
 *   行数の上限(sheetRows)を当てるので、その前に止める(@codex PR#456 5巡目)。
 * ⚠中央ディレクトリの「展開後サイズ」の**申告は信じない**(偽れる)。中身を1つずつ
 *   zlib の maxOutputLength つきで実際に展開し、合計が上限を超えた時点で止める。
 */
import { inflateRawSync } from "node:zlib";

export class ZipGuardError extends Error {}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** 中身の数の上限(ふつうの Excel は数十)。 */
const MAX_ENTRIES = 2000;

function findEocd(buf: Buffer): number {
  // EOCD は末尾22バイト+コメント(最大65535)の範囲にある。
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

export function assertZipExpandsWithin(buf: Buffer, maxBytes: number): void {
  if (buf.length < 22) throw new ZipGuardError("not a zip");
  const eocd = findEocd(buf);
  if (eocd === -1) throw new ZipGuardError("not a zip");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countOnDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  // ⚠**件数の欄は2つとも見て、食い違いは断る**(@codex PR#456 9巡目)。
  //   xlsx の読み手(SheetJS parse_zip)は「このディスクの件数」(+8)で展開する。
  //   こちらが「全体の件数」(+10)だけを見ると、+10 を0に偽った ZIP で
  //   1件も数えずに通してしまい、読み手はすべて展開する。
  //   分割 ZIP・中身ゼロ(正しい Excel ではありえない)・ZIP64 も扱わずに断る。
  if (
    disk !== 0 ||
    cdDisk !== 0 ||
    countOnDisk !== count ||
    count === 0 ||
    count === 0xffff ||
    p === 0xffffffff ||
    count > MAX_ENTRIES
  ) {
    throw new ZipGuardError("unsupported zip");
  }
  const cdEnd = p + cdSize;

  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ZipGuardError("broken central directory");
    }
    const p0 = p;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + extraLen + commentLen;

    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL_SIG) {
      throw new ZipGuardError("broken local header");
    }
    // ⚠**中央ディレクトリとローカル見出しの食い違いは断る**(@codex PR#456 10巡目)。
    //   読み手(SheetJS)はローカル見出しの圧縮方式を信じて展開する。中央で「無圧縮」、
    //   ローカルで「deflate」と偽られると、こちらは圧縮後の長さしか数えずに通してしまう。
    //   圧縮後サイズも、データ記述子を使わない中身(bit 3 が立っていない)では一致を求める。
    const flags = buf.readUInt16LE(p0 + 8);
    const localMethod = buf.readUInt16LE(localAt + 8);
    const localCompSize = buf.readUInt32LE(localAt + 18);
    if (localMethod !== method) throw new ZipGuardError("method mismatch");
    // データ記述子あり(bit 3)でも、ローカルの値は「0(記述子へ回す)」か「中央と同じ」だけ
    // (@codex PR#456 12巡目)。読み手はローカルの値で切り出す・展開するので、
    // 違う値を許すと中央の申告を小さくしたまま大きく読ませられる。
    if (!sizeAgrees(localCompSize, compSize, flags)) throw new ZipGuardError("size mismatch");
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    if (dataAt + compSize > buf.length) throw new ZipGuardError("truncated entry");
    const data = buf.subarray(dataAt, dataAt + compSize);

    // ⚠**申告された展開後サイズも確かめる**(@codex PR#456 11巡目)。読み手(SheetJS)は
    //   ローカル見出しの申告どおりに展開先の領域を確保するので、実際は数バイトでも
    //   申告だけ巨大にされるとメモリを取られる。
    //   ・ZIP64 の拡張フィールド(申告を別の場所で差し替えられる)は扱わずに断る
    //   ・中央・ローカルの申告は残りの枠以内。データ記述子なし(bit 3 なし)なら両者一致
    //     (実物の Excel はデータ記述子ありで、ローカルの申告は0)
    //   ・実際に展開した大きさが中央の申告と一致すること
    if (
      hasZip64Extra(buf, p0 + 46 + nameLen, extraLen) ||
      hasZip64Extra(buf, localAt + 30 + localNameLen, localExtraLen)
    ) {
      throw new ZipGuardError("zip64 not supported");
    }
    const declaredSize = buf.readUInt32LE(p0 + 24);
    const localDeclaredSize = buf.readUInt32LE(localAt + 22);
    const remaining = maxBytes - total;
    if (declaredSize > remaining || localDeclaredSize > remaining) {
      throw new ZipGuardError("declared size too large");
    }
    if (!sizeAgrees(localDeclaredSize, declaredSize, flags)) {
      throw new ZipGuardError("declared size mismatch");
    }

    let actual: number;
    if (method === 0) {
      actual = data.length; // 無圧縮
    } else if (method === 8) {
      try {
        // ⚠残りの枠を超えたら zlib 自身が展開を打ち切る(メモリに載せきらない)。
        actual = inflateRawSync(data, { maxOutputLength: Math.max(1, remaining + 1) }).length;
      } catch {
        throw new ZipGuardError("expands too large or broken");
      }
    } else {
      throw new ZipGuardError("unsupported compression");
    }
    if (actual !== declaredSize) throw new ZipGuardError("declared size differs from actual");
    total += actual;
    if (total > maxBytes) throw new ZipGuardError("expands too large");
  }
  // 数えた中身で中央ディレクトリをちょうど読み切っていること(件数の偽りの別の形)。
  if (p !== cdEnd) throw new ZipGuardError("central directory size mismatch");
}

/** 拡張フィールドの並び(id 2バイト・長さ2バイト・中身)に ZIP64(0x0001)があるか。 */
function hasZip64Extra(buf: Buffer, at: number, len: number): boolean {
  const end = at + len;
  if (end > buf.length) throw new ZipGuardError("broken extra field");
  let q = at;
  while (q + 4 <= end) {
    if (buf.readUInt16LE(q) === 0x0001) return true;
    q += 4 + buf.readUInt16LE(q + 2);
  }
  return false;
}

/** ローカル見出しのサイズが中央と整合しているか(データ記述子ありなら 0 も可)。 */
function sizeAgrees(local: number, central: number, flags: number): boolean {
  if (local === central) return true;
  return (flags & 0x08) !== 0 && local === 0;
}

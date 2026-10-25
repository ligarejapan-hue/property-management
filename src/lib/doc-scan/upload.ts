/**
 * 書類を撮る — 送られてきたページの検査と、保存のときの名前(純関数・サーバーと画面の両方で使う)。
 */

/** 1ページの上限。端末で長い辺 2000px の JPEG にしてから送るので、ふつうは 0.5MB 前後(超えたら端末で画質を下げて収める)。 */
export const MAX_SCAN_PAGE_BYTES = 1.5 * 1024 * 1024;

/**
 * 送信全体の上限(30ページ × 1.5MB = 45MB に余白)。⚠本文を読む前に Content-Length で見る。
 * ⚠大きいPDFの口と同じ 50MB にそろえる=nginx の見本(client_max_body_size 52m)に収まる(@codex #594 P2)。
 */
export const MAX_SCAN_BODY_BYTES = 50 * 1024 * 1024;

/** 読めた文字(空白を除く)がこれ未満なら「写真タブへ移す」を出す。 */
export const LITTLE_TEXT_CHARS = 30;

export type ScanImageKind = "jpeg" | "png" | "webp";

/** 先頭のバイトで画像の種類を見分ける。申告された種類(Content-Type)は信じない。 */
export function sniffImage(buf: Buffer): ScanImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return "webp";
  }
  return null;
}

/** 保存する元の名前。種類が当たれば画面には「種類_物件名 号室_日付」が出る(docTitle)。 */
export function scanFileName(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}`;
  return `撮影した書類_${date}_${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}.pdf`;
}

/** 読み取りができて、それでも文字がほとんど無かったときだけ写真の候補にする。 */
export function hasLittleText(scan: { ocr: "done" | "unavailable" | "failed"; ocrChars: number }): boolean {
  return scan.ocr === "done" && scan.ocrChars < LITTLE_TEXT_CHARS;
}

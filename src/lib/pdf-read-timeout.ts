/**
 * PDF の文字の抜き出しが時間の上限を超えたときのエラーの code(extractTextFromPdf の timeoutMs)。
 * ⚠pdf-extract とは別のファイルに置く(多くのテストが pdf-extract を作り物に差し替えるので、
 *   そこに置くと差し替えた側で「その名前が無い」になる)。
 */
export const PDF_READ_TIMEOUT = "PDF_READ_TIMEOUT";

/**
 * 時間切れで打ち切ったが、裏でまだ続いている読み取り(@codex #681)。
 * ⚠pdf.js の読み取りは途中で止められない(打ち切っても呼び出し元に返るだけで、解析は続く)。
 *   名義の比べはこれが残っている間は次の物件を始めない=重い読み取りを裏に積み上げない。
 * ⚠いつまでも終わらない読み取りで比べが止まり続けないよう、STALE_MS を過ぎたものは数えない。
 */
const TIMED_OUT_READ_STALE_MS = 10 * 60_000;
const timedOutReads = new Set<{ at: number }>();

/** 時間切れの読み取りを、終わるまで数に入れる。 */
export function trackTimedOutPdfRead(settled: Promise<unknown>, now = Date.now()): void {
  const entry = { at: now };
  timedOutReads.add(entry);
  const done = () => {
    timedOutReads.delete(entry);
  };
  void settled.then(done, done);
}

/** 時間切れで打ち切った読み取りが、裏でまだ続いているか(STALE_MS より古いものは除く)。 */
export function hasPendingTimedOutPdfRead(now = Date.now()): boolean {
  for (const e of timedOutReads) {
    if (now - e.at < TIMED_OUT_READ_STALE_MS) return true;
  }
  return false;
}

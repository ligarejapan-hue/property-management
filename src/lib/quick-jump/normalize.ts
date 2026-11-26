/**
 * 検索の枠(どこからでも開ける「探す」)の文字のそろえ方。
 * 打った言葉と登録した言葉を同じ形にしてから比べる:
 * - 全角/半角・大文字/小文字をそろえる(NFKC+小文字)
 * - カタカナをひらがなに(「ドライブ」と「どらいぶ」を同じに)
 * - 空白・記号(？。、「」・など)を落とす
 * - ヶ/ケ/ヵ/カ の揺れ(「ヶ月」「か月」)は ヶ→け・ヵ→か(カタカナ→ひらがなの後で同じになる)
 */
export function normalizeQuery(input: string): string {
  const s = (input ?? "").normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    // カタカナ(ァ〜ヶ)→ひらがな。ヵ(30F5)→か・ヶ(30F6)→け
    if (code === 0x30f5) out += "か";
    else if (code === 0x30f6) out += "け";
    else if (code >= 0x30a1 && code <= 0x30f4) out += String.fromCodePoint(code - 0x60);
    else if (/[\p{L}\p{N}ー]/u.test(ch)) out += ch;
    // それ以外(空白・句読点・記号)は落とす
  }
  return out;
}

/** a の文字が b の中に順番どおりに全部あるか(間に別の字があってよい)。「取引確認書」→「取引完了確認書」 */
export function isSubsequence(a: string, b: string): boolean {
  const want = Array.from(a);
  if (want.length === 0) return true;
  let i = 0;
  for (const ch of b) {
    if (ch === want[i]) {
      i += 1;
      if (i === want.length) return true;
    }
  }
  return false;
}

/**
 * 謄本テキストの共通の正規化。
 *
 * `pdf-registry-parser.ts` と `registry-owner-table.ts` の両方から使う。
 * 片方に置くと import が循環するのでここに切り出している。
 */

/**
 * 謄本でよくある「スペース区切り漢字」を結合する。
 * 例: "坂 本 周 守" → "坂本周守"
 *     "世 田 谷 区" → "世田谷区"
 * ただし住所に含まれる数字区切りは維持する。
 */
export function joinSpacedKanji(s: string): string {
  // 漢字・ひらがな・カタカナが1文字スペース1文字のパターンを結合
  return s.replace(
    /([　-鿿゠-ヿ぀-ゟ]) ([　-鿿゠-ヿ぀-ゟ])/g,
    "$1$2",
  );
}

/**
 * 全角数字だけを半角にする。
 *
 * ⚠ `pdf-registry-parser.ts` の `normalizeNumber` とは別物。あちらは地積の表記を
 * 直すために中点(・)を小数点へ変換するが、氏名・住所に同じことをすると
 * 「ハイツ・サンプル」のような表記を壊す。ここでは数字だけを扱う。
 */
export function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
}

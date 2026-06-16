/**
 * text-hygiene-display.ts (DQ-04 監査表示ヘルパ・純関数)
 *
 * 監査表（text-hygiene ページ）で owner の生値をそのまま描画すると、
 * (1) 制御文字 / ゼロ幅 / BOM は不可視で「何が問題か」が見えず、
 * (2) 双方向制御（RLO 等）は監査セルの **表示順を実際に改変** してしまう（Codex P2）。
 * そこで描画前に、これら不可視・危険文字を可視のエスケープ表記（\uXXXX）へ置換する。
 * 不可視文字を視認可能にし、bidi による表示改変を無害化する。
 *
 * 対象 = owner-text-hygiene.ts の removable 集合（C0/C1/DEL〔\t\n\r 除く〕・ゼロ幅・BOM・
 * bidi マーク/埋め込み/上書き/isolate）+ U+FFFD（置換文字）。
 * mojibake（誤デコードの可視ラテン残骸 Â£ 等）は **可視文字** ゆえ対象外（issue バッジで示す）。
 * 通常文字・全角・改行/タブ・絵文字（astral / surrogate pair）は不変。
 *
 * no-control-regex を避けるため正規表現ではなくコードポイント数値比較で判定する。
 */

function isVisualizeTarget(cp: number): boolean {
  return (
    (cp >= 0x00 && cp <= 0x08) || // C0（\t=09 \n=0a \r=0d は除外）
    cp === 0x0b ||
    cp === 0x0c ||
    (cp >= 0x0e && cp <= 0x1f) ||
    (cp >= 0x7f && cp <= 0x9f) || // DEL + C1
    cp === 0x061c || // ALM（bidi マーク）
    (cp >= 0x200b && cp <= 0x200f) || // ZWSP/ZWNJ/ZWJ + LRM/RLM
    cp === 0x2060 || // WJ
    cp === 0xfeff || // BOM
    (cp >= 0x202a && cp <= 0x202e) || // bidi 埋め込み/上書き（LRE..RLO）
    (cp >= 0x2066 && cp <= 0x2069) || // bidi isolate（LRI..PDI）
    cp === 0xfffd // 置換文字（文字化けマーカ）
  );
}

function escapeCodePoint(cp: number): string {
  return `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * 監査表示用に不可視・双方向制御・U+FFFD を \uXXXX へエスケープする。
 * 通常文字・全角・絵文字はそのまま。空/null/undefined は空文字。冪等ではない
 * （元から "\u" を含む文字列は変化しないが、エスケープ済み表記を再適用しても増殖しない）。
 */
export function visualizeTextHygiene(
  value: string | null | undefined,
): string {
  if (!value) return "";
  let out = "";
  // for...of は code point 単位で反復する（surrogate pair の絵文字を壊さない）。
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isVisualizeTarget(cp) ? escapeCodePoint(cp) : ch;
  }
  return out;
}

/**
 * 日本語CSV を文字化けなく読むためのデコーダ。
 *
 * 実務で来る日本語CSV (Excel / 役所 / 不動産業者 etc.) は次のいずれか:
 *  - UTF-8 (BOM付き)
 *  - UTF-8 (BOMなし)
 *  - Shift-JIS / CP932 (Windows-31J)
 *
 * 戦略:
 *  1) 先頭が UTF-8 BOM (EF BB BF) → UTF-8 として decode (BOM は除去)
 *  2) それ以外は厳格UTF-8 (fatal: true) を試す。成功すれば UTF-8 とみなす
 *  3) UTF-8 で例外が出たら Shift-JIS で decode する。
 *     ブラウザの TextDecoder("shift_jis") は Windows-31J を返すので
 *     CP932 (Excel 系の "Shift_JIS") をカバーできる。
 *  4) Shift-JIS でも失敗したら非fatal UTF-8 (置換文字あり) で返す。
 *     先頭で例外を投げて UI を死なせないため。
 *
 * 既存 UTF-8 CSV は (1)(2) で従来どおり通るので互換性あり。
 */
export async function readCsvFileAsText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);

  // (1) UTF-8 BOM
  if (
    u8.length >= 3 &&
    u8[0] === 0xef &&
    u8[1] === 0xbb &&
    u8[2] === 0xbf
  ) {
    return new TextDecoder("utf-8").decode(u8.subarray(3));
  }

  // (2) 厳格UTF-8
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(u8);
  } catch {
    // (3) Shift-JIS / CP932 フォールバック
    try {
      return new TextDecoder("shift_jis", { fatal: false }).decode(u8);
    } catch {
      // (4) 最終フォールバック: 非fatal UTF-8 (置換文字混在)
      return new TextDecoder("utf-8").decode(u8);
    }
  }
}

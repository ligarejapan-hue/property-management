/**
 * 外部製「不動産登記情報自動化システム」が出力する所有者事項PDFの
 * ファイル名を分解する純関数。
 *
 * 形式: `{所在}不動産登記（{土地|建物}所有者事項）{請求番号}.PDF`
 *   例: 世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF
 *
 * 所在は受付帳Excel由来の文字列で、受付帳取込が作る Property.address と
 * 同一ソースのため、正規化完全一致での物件突合キーとして使える。
 */

export interface RegistryPdfBulkFilename {
  location: string;
  kind: "土地" | "建物" | null;
  requestNumber: string;
}

// 括弧は全角（）。請求番号は実サンプルで16桁だが、桁数変更に備え10〜20桁を許容。
// 末尾の " (1)" はエクスプローラのコピーで付くサフィックスとして許容する。
const FILENAME_PATTERN =
  /^(.+?)不動産登記（(土地|建物)?所有者事項）(\d{10,20})(?:\s*\(\d+\))?\.pdf$/i;

/**
 * ファイル名から謄本の請求種別を推定する。
 *
 * 一括取込・手動添付は種別を UI で選ばない(単発取込だけが2択を持つ)。外部製ソフトの
 * 出力名は「…（土地|建物所有者事項）…」形式なので、名前から owner/all を判定して
 * Attachment.registryCertificateType に保存する。判定できなければ null(その他扱い)。
 * 物件基本情報の「謄本 ○件」の種別内訳がこの値に依存する(@codex #429 P2)。
 */
export function inferRegistryCertificateType(
  fileName: string | null | undefined,
): "owner" | "all" | null {
  if (!fileName) return null;
  const s = fileName.normalize("NFC");
  if (s.includes("所有者事項")) return "owner";
  if (s.includes("全部事項")) return "all";
  return null;
}

export function parseRegistryPdfBulkFilename(
  fileName: string | null | undefined,
): RegistryPdfBulkFilename | null {
  if (!fileName) return null;
  // macOS由来のNFD分解文字を合成しておく(濁点分離などでの取りこぼし防止)
  const m = fileName.normalize("NFC").trim().match(FILENAME_PATTERN);
  if (!m) return null;
  const location = m[1].trim();
  if (!location) return null;
  return {
    location,
    kind: (m[2] as "土地" | "建物" | undefined) ?? null,
    requestNumber: m[3],
  };
}

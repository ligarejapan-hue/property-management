import { getStorage } from "@/lib/storage";
import type { SalesSheetDocument, SalesSheetElement } from "./document-schema";

/**
 * document 内の画像 src を出力可能な形に整える。
 *  - 既に data: の src はそのまま。
 *  - それ以外（/uploads/ 等）は storage から bytes を読み data: URL に展開。
 *  - key 解決不可 / read null / 例外 の画像要素は取り除く（壊れた src を残さない）。
 * バイト列・key・URL はログに出さない。
 */
export async function inlineDocumentImages(
  doc: SalesSheetDocument,
): Promise<SalesSheetDocument> {
  const storage = getStorage();
  const out: SalesSheetElement[] = [];
  for (const el of doc.elements) {
    if (el.type !== "image") {
      out.push(el);
      continue;
    }
    if (el.src.startsWith("data:")) {
      out.push(el);
      continue;
    }
    const key = storage.keyFromUrl(el.src);
    if (!key) continue; // 解決不可 → 取り除く
    try {
      const result = await storage.read(key);
      if (!result) continue; // 存在しない → 取り除く
      const b64 = result.body.toString("base64");
      out.push({ ...el, src: `data:${result.contentType};base64,${b64}` });
    } catch {
      continue; // I/O エラー → 取り除く（詳細はログに出さない）
    }
  }
  return { ...doc, elements: out };
}

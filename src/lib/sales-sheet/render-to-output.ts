import { renderDocumentToHtml } from "./render-html";
import { renderHtmlToPdf, renderHtmlToImage } from "./output";
import type { SalesSheetDocument } from "./document-schema";

/** document → HTML → PDF（page 寸法を自動適用）。 */
export async function renderDocumentToPdf(doc: SalesSheetDocument): Promise<Buffer> {
  return renderHtmlToPdf(renderDocumentToHtml(doc), {
    widthMm: doc.page.width,
    heightMm: doc.page.height,
  });
}

/** document → HTML → 画像。 */
export async function renderDocumentToImage(
  doc: SalesSheetDocument,
  format: "png" | "jpeg" = "png",
): Promise<Buffer> {
  return renderHtmlToImage(renderDocumentToHtml(doc), { format });
}

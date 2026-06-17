import { z } from "zod";

/**
 * PaddleOCR ローカルサービス（POST /ocr）のレスポンス契約。
 * 本体実装は別 deploy（repo 外）。Node 側はこの schema で受信を検証する。
 */
export const ocrResponseSchema = z.object({
  text: z.string(),
  pages: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
  elapsedMs: z.number().nonnegative().optional(),
});
export type OcrResponse = z.infer<typeof ocrResponseSchema>;

/**
 * registry extraction strategy の共通中間表現（confirm 前・非永続）。
 * OCR は「pdf_text を置換する」のではなく extractionMethod の 1 値にすぎない。
 */
export type RegistrySourceType =
  | "digital_pdf"
  | "scanned_pdf"
  | "manual_paste"
  | "unknown";
export type RegistryExtractionMethod = "pdf_text" | "local_ocr" | "manual";
export type RegistryReliability = "high" | "medium" | "low";

export interface RegistryExtraction {
  sourceType: RegistrySourceType;
  extractionMethod: RegistryExtractionMethod;
  text: string;
  warnings: string[];
  reliability: RegistryReliability;
}

/**
 * 既存 parseRegistryText の confidence(0-1) を reliability ラベルへ導出する。
 * 新たなスコアは作らない（UI 表示用ラベルのみ）。
 */
export function reliabilityFromConfidence(
  confidence: number,
): RegistryReliability {
  if (!Number.isFinite(confidence)) return "low";
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.4) return "medium";
  return "low";
}

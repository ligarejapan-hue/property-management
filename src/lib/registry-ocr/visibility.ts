/**
 * 「OCRで下書き生成」導線を UI に出すかの純判定。
 *
 * page.tsx は vitest 非対象（.test.ts のみ）ゆえ、出し分けロジックをここへ切り出して
 * 単体テストする。digital-native PDF（embedded_text = !isLikelyScanned）には
 * **絶対に出さない**＝非回帰の最重要条件。
 */
export interface OcrDraftVisibilityInput {
  isLikelyScanned: boolean;
  ocrConfigured: boolean;
  isAdmin: boolean;
}

export function shouldOfferOcrDraft(input: OcrDraftVisibilityInput): boolean {
  return (
    input.isLikelyScanned === true &&
    input.ocrConfigured === true &&
    input.isAdmin === true
  );
}

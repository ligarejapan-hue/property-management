import type { LetterOptions } from "./types";

// variant が持つ options 相当のフィールド(sender は含まない)。
export interface VariantOptionFields {
  designTemplate: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  extraInstruction: string | null;
}

// この通だけの調整差分(LetterOptions の部分集合・sender は対象外)。
export type DraftOverride = Partial<{
  designTemplate: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  extraInstruction: string | null;
}>;

// override のうち上書きを許す安全なキー(sender 等の混入を防ぐ allowlist)。
const OVERRIDABLE_KEYS = [
  "designTemplate",
  "tone",
  "length",
  "appeal",
  "strength",
  "extraInstruction",
] as const;

/**
 * variant 設定に「この通だけの上書き(override)」を shallow merge し、
 * 差出人を足して LetterOptions を組み立てる(再生成・プレビューで使う)。
 *  - override の許可キーのみ反映(sender 等は無視)。
 *  - extraInstruction の null は undefined に正規化(prompt builder の任意項目に合わせる)。
 */
export function resolveDraftOptions(
  variant: VariantOptionFields,
  override: DraftOverride | null | undefined,
  sender: { senderName: string; senderContact: string },
): LetterOptions {
  const merged: VariantOptionFields = { ...variant };
  if (override) {
    for (const key of OVERRIDABLE_KEYS) {
      if (override[key] !== undefined) {
        // 許可キーのみ反映する(allowlist)。
        (merged as unknown as Record<string, unknown>)[key] = override[key];
      }
    }
  }
  return {
    designTemplate: merged.designTemplate,
    tone: merged.tone,
    length: merged.length,
    appeal: merged.appeal,
    strength: merged.strength,
    senderName: sender.senderName,
    senderContact: sender.senderContact,
    extraInstruction: merged.extraInstruction ?? undefined,
  };
}

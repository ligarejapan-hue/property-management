/**
 * 手紙本文の差込タグ（設計 2026-08-08-sale-dm-external-paste-design.md §2.2）。
 *
 * 1つの型（variant）の本文は**複数物件の宛先にまたがる**ため、プロンプトに個別物件の
 * 事実を書かせると別の物件へ送られてしまう。物件ごとに変わる部分はタグで書かせ、
 * **適用時にシステムが物件ごとに差し込む**。
 *
 * ⚠語彙を増やすときは設計 §2.2 の見直しから。ここが**唯一の定義元**で、
 * プロンプトの説明文・貼り付け検証・適用時の展開がすべてこの表を見る。
 */
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

export const LETTER_TAGS = ["物件所在", "物件種別"] as const;
export type LetterTag = (typeof LETTER_TAGS)[number];

/**
 * 物件所在を「市区町村＋町名（丁目まで）」に丸める。
 * ⚠番地・号は落とす＝共通本文に**建物が特定できる粒度**を載せない。
 * 丁目は町名の一部として自然に読めるので残す。
 */
export function coarsePropertyLocation(address: string | null): string | null {
  const s = (address ?? "").trim();
  if (s.length === 0) return null;
  // 末尾の「番地部分」（数字で始まり、数字・各種ハイフン・番・号・の が続く）を落とす。
  // 「◯丁目」で終わる場合はそこまでを残す。
  const trimmed = s.replace(
    /[0-9０-９][0-9０-９\-－‐―ー番号の]*$/,
    "",
  );
  const head = trimmed.replace(/[-－‐―ー\s]+$/, "").trim();
  return head.length > 0 ? head : null;
}

/** 物件種別の表示名（既存の一覧・CSVと同じ出所）。 */
export function propertyTypeLabel(propertyType: string | null): string | null {
  if (!propertyType) return null;
  return PROPERTY_TYPE_LABELS[propertyType] ?? propertyType;
}

/** 許可タグだけを値で置き換える。値が null のタグは**置き換えない**（未解決として残す）。 */
export function expandLetterTags(
  text: string,
  values: { location: string | null; propertyType: string | null },
): string {
  const table: Record<LetterTag, string | null> = {
    物件所在: values.location,
    物件種別: values.propertyType,
  };
  let out = text;
  for (const tag of LETTER_TAGS) {
    const value = table[tag];
    if (value == null) continue;
    out = out.split(`{{${tag}}}`).join(value);
  }
  return out;
}

/** 展開後に差込の記号が残っているか（未知タグ・綴り違い・値が無いタグ）。 */
export function hasUnresolvedTag(text: string): boolean {
  return text.includes("{{");
}

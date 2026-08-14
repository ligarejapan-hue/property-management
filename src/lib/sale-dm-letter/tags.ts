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

  // ⚠**末尾を削るのではなく、番地が始まる位置で切る**（@codex #376 R4）。
  //   末尾だけ見る作りだと「…2丁目8番1号 新宿ビル101」から `101` しか落ちず、
  //   建物が特定できる住所が共通の文面に載ってしまう。
  //   ・数字の並びが「◯丁目」なら町名の一部として残し、その先を見続ける
  //   ・そうでない数字の並びが出たら、そこで切る（＝番地の始まり）
  //   ・空白が出たらそこで切る（日本の住所は建物名の前に空白が入る）
  const DIGITS = /[0-9０-９]/;
  // ⚠漢数字は「地名の一部」でもあり得る（六本木・四谷・三田・九段）ので、数字扱いに
  //   してはいけない（@codex #376 R5）。**直後が 丁目/番/号/番地 のときだけ**
  //   番地の一部と判断する。
  const KANJI_NUM = /[〇零一二三四五六七八九十百]/;
  //   ⚠「◯番町」は町名（千代田区一番町〜六番町）なので、ここの 番 は番地ではない
  //   （@codex #376 R6）。番 の直後が 町 のときは町名の一部として扱う。
  const isUnitAt = (at: number) =>
    s.startsWith("丁目", at) ||
    s.startsWith("番地", at) ||
    (s.startsWith("番", at) && !s.startsWith("番町", at)) ||
    s.startsWith("号", at);
  let cut = s.length;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/[\s　]/.test(ch)) {
      cut = i;
      break;
    }
    if (DIGITS.test(ch)) {
      let j = i;
      while (j < s.length && DIGITS.test(s[j])) j += 1;
      if (s.slice(j, j + 2) === "丁目") {
        i = j + 2; // 町名の一部。ここまでは残して先を見る
        continue;
      }
      cut = i; // 番地の始まり
      break;
    }
    if (KANJI_NUM.test(ch)) {
      let j = i;
      while (j < s.length && KANJI_NUM.test(s[j])) j += 1;
      if (s.slice(j, j + 2) === "丁目") {
        i = j + 2; // 「二丁目」は町名の一部
        continue;
      }
      if (isUnitAt(j)) {
        cut = i; // 「八番」「一号」= 番地の始まり
        break;
      }
      i = j; // 地名の一部（六本木など）。切らずに先へ
      continue;
    }
    i += 1;
  }

  const head = s
    .slice(0, cut)
    .replace(/[-－‐―ー\s　]+$/, "")
    .trim();
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

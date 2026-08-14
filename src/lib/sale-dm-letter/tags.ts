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

/** 番地の区切りに使われる各種ハイフン（全角/半角・ダッシュ・長音記号の代用まで）。 */
const HYPHENS = /[-－‐‑–—―−ー]/;

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
  // ⚠数字の並びの直後がこれらのときは、その数字ごと**町名の一部**（番地ではない）。
  //   ・丁目 = 町名の一部として自然に読める
  //   ・番町 = 千代田区一番町〜六番町（@codex #376 R6）
  //   ・番丁 = 仙台市青葉区一番丁〜五番丁・和歌山市一番丁〜七番丁（@codex #376 R8）
  //   ・条 / 線 = 北海道の書き方（札幌市中央区北1条西2丁目・旭川市1条通・
  //     芽室町東2線）。町名と見ないと「中央区北」で切れて意味の通らない文になる
  //     （@codex #376 R17）
  //   「丁」も「町」と同じく町名の字。**漢数字でも算用数字でも同じ扱い**にする
  //   （「1番町」のような表記ゆれで町名が消えないように）。
  // ⚠**号 は入れない**。地名として使う地域（芽室町の「南7号」など）もあるが、
  //   圧倒的多数は番地なので、迷ったら**切る**側に倒す（残しすぎ＝住所が漏れる）。
  const TOWN_SUFFIXES = ["丁目", "番町", "番丁", "条", "線"] as const;
  const townSuffixAt = (at: number) =>
    TOWN_SUFFIXES.find((suffix) => s.startsWith(suffix, at));
  // 町名の字（上の表）でないことを確かめた上で呼ぶ＝ここに来た 番/号 は番地。
  // ⚠**ハイフンも番地の区切り**（@codex #376 R13）。「二丁目八－一」のように 番/号 を
  //   書かない番地があり、記号だけを見ないと地名の一部と誤解して**建物が特定できる
  //   住所がそのまま**共通の文面に載る。地名の漢数字（六本木・四谷）の直後に
  //   ハイフンが来ることは無いので、番地の始まりと判断してよい。
  const isUnitAt = (at: number) =>
    s.startsWith("番", at) || s.startsWith("号", at) || HYPHENS.test(s[at] ?? "");
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
      const suffix = townSuffixAt(j);
      if (suffix) {
        i = j + suffix.length; // 「2丁目」「1番町」は町名の一部。残して先を見る
        continue;
      }
      // ⚠数字のあとが**番地の始まりだと分かる形**のときだけ切る。そうでなければ
      //   「知らない書き方」＝この関数が理解できていない住所なので、**途中で切れた
      //   町名を名乗らない**（null＝未解決。適用時に飛ばして件数で報告される）。
      //   この関数は表記からの推定なので知らない語尾は必ず出てくる（実際 条/線 で
      //   作り直した）。そのとき意味の通らない住所が全宛先の手紙に載るより、
      //   飛ばして人に見せるほうが安全。
      const after = s[j] ?? "";
      const isLotBoundary =
        j >= s.length ||
        HYPHENS.test(after) ||
        /[\s　]/.test(after) ||
        after === "番" ||
        after === "号" ||
        after === "の";
      if (!isLotBoundary) return null;
      cut = i; // 番地の始まり
      break;
    }
    if (KANJI_NUM.test(ch)) {
      let j = i;
      while (j < s.length && KANJI_NUM.test(s[j])) j += 1;
      const suffix = townSuffixAt(j);
      if (suffix) {
        i = j + suffix.length; // 「二丁目」「一番町」「二番丁」は町名の一部
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

/**
 * 展開後に差込の記号が残っているか（未知タグ・綴り違い・値が無いタグ・書き損じ）。
 *
 * ⚠**開き側だけを見ない**（@codex #376 R12）。`{{物件所在}}}` は展開すると閉じ側の `}` が
 * 残るが、`{{` を探す検査では見逃して手紙に記号が残ったまま刷られる。差し込む値（住所・
 * 種別）に波かっこは入らないので、残っていたら1文字でも未解決とみなす。
 */
export function hasUnresolvedTag(text: string): boolean {
  return text.includes("{") || text.includes("}");
}

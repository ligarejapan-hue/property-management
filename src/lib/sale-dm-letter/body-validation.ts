/**
 * 売却DM 手紙本文の検証（設計 2026-08-08-sale-dm-external-paste-design.md §2.3）。
 *
 * **単一定義元**。本 PR では個別の下書き編集から通し、PR-D2 で
 * 「貼り付け保存」「全宛先に適用」も同じ関数に通す（同じ結果を生む全経路に同じ門）。
 * DB を触らない純関数のみ。HTTP ステータス化は呼び出し側 route の責務。
 *
 * ⚠差込タグ（`{{...}}`）の扱いは呼び出し側が選ぶ。
 *   - 既定（`allowTags` なし）= `{{` を含む本文をすべて弾く。**個別の下書き編集**は
 *     物件が確定しているので、タグではなく展開後の本文が入るべき。
 *   - `allowTags: true` = tags.ts の許可タグだけを通す。**型の本文（貼り付け）**は
 *     複数物件にまたがるのでタグが必要（設計 §2.2）。
 *   どちらも「知らないタグ・綴り違い」は弾く＝プレースホルダのまま郵送されない。
 */
import { LETTER_TAGS } from "./tags";

/** 貼り付け・編集で受け付ける本文の上限。印刷レイアウトの最大想定に対して十分な余裕（設計 §2.3）。 */
export const LETTER_BODY_MAX_LENGTH = 20_000;

export type LetterBodyIssue = "empty" | "unknown_tag" | "too_long";

/** 問題があればその種類を、無ければ null を返す。 */
export function validateLetterBody(
  body: string,
  options: { allowTags?: boolean } = {},
): LetterBodyIssue | null {
  // 空判定を最初に（空文字に「長すぎ」「タグ」の理由を出さない）。
  if (body.trim().length === 0) return "empty";
  if (body.length > LETTER_BODY_MAX_LENGTH) return "too_long";
  // 許可タグを取り除いてから残りを見る。⚠取り除く対象は tags.ts の語彙だけ
  //（同じ表を2か所に書かない）。取り除いた後に `{{` が残る＝未知タグ・綴り違い。
  const rest = options.allowTags
    ? LETTER_TAGS.reduce((acc, tag) => acc.split(`{{${tag}}}`).join(""), body)
    : body;
  if (rest.includes("{{")) return "unknown_tag";
  return null;
}

/** 画面にそのまま出せる日本語の説明（内部識別子を露出させない）。 */
export function letterBodyIssueMessage(issue: LetterBodyIssue): string {
  switch (issue) {
    case "empty":
      return "本文が空です。空白や改行だけの本文は保存できません";
    case "too_long":
      return `本文が長すぎます（${LETTER_BODY_MAX_LENGTH.toLocaleString()}字まで）`;
    case "unknown_tag":
      return "本文に差し込みの記号（{{ }}）が残っています。そのまま印刷されてしまうため保存できません";
  }
}

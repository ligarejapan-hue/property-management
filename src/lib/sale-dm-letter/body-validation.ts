/**
 * 売却DM 手紙本文の検証（設計 2026-08-08-sale-dm-external-paste-design.md §2.3）。
 *
 * **単一定義元**。本 PR では個別の下書き編集から通し、PR-D2 で
 * 「貼り付け保存」「全宛先に適用」も同じ関数に通す（同じ結果を生む全経路に同じ門）。
 * DB を触らない純関数のみ。HTTP ステータス化は呼び出し側 route の責務。
 *
 * ⚠差込タグ（`{{...}}`）は **PR-D2 で導入する**。この PR の時点では正規のタグが
 * 存在しないので、`{{` を含む本文はすべて弾く（未知タグ＝プレースホルダのまま
 * 郵送される事故を先に塞ぐ）。PR-D2 で許可タグ（物件所在／物件種別）を
 * この関数に足し、許可タグだけを通す形へ広げる。
 */

/** 貼り付け・編集で受け付ける本文の上限。印刷レイアウトの最大想定に対して十分な余裕（設計 §2.3）。 */
export const LETTER_BODY_MAX_LENGTH = 20_000;

export type LetterBodyIssue = "empty" | "unknown_tag" | "too_long";

/** 問題があればその種類を、無ければ null を返す。 */
export function validateLetterBody(body: string): LetterBodyIssue | null {
  // 空判定を最初に（空文字に「長すぎ」「タグ」の理由を出さない）。
  if (body.trim().length === 0) return "empty";
  if (body.length > LETTER_BODY_MAX_LENGTH) return "too_long";
  if (body.includes("{{")) return "unknown_tag";
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

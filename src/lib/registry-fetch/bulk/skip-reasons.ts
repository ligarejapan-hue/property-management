/**
 * 一括取得で「対象外になった理由」の日本語ラベル。
 *
 * ⚠理由によって利用者のやることが違う(設計 §3.1.0)。すべてを「地番が未入力」と
 *   書くと、住所が無い物件や不動産番号を持つ物件の担当者は何を直せばよいか
 *   分からず詰まる。
 *
 * ⚠ここが**唯一の定義元**。作成を断る 409 のメッセージ(サーバ)と進捗画面の内訳
 *   (クライアント)の両方が使う。片方だけ直すと、同じ理由が画面によって違う
 *   言い方になる。
 */
export const BULK_SKIP_REASON_LABEL: Record<string, string> = {
  missing_identifier: "地番・家屋番号が未入力",
  malformed_identifier: "地番/家屋番号の書き方",
  insufficient_location: "住所が未入力",
  // ⚠「直せば通る」ものではない。番号での取得は実サイトに触れる前に止まる
  //   (段階②が未実装)ので、この経路では取得できない。
  has_real_estate_number: "所在検索の対象外（この経路では取得できません）",
  identifier_changed: "内容が変わりました（確認して選び直してください）",
  // ⚠確認画面を通していない物件(古い画面のまま実行された等)。
  not_approved: "確認を通していません（選び直してください）",
  ambiguous_candidate: "候補が複数（手動で選んでください）",
  no_candidate: "候補が見つかりません",
  property_unavailable: "物件を参照できません",
};

/**
 * 理由コードの並びを「理由: N件」の文にする。
 *
 * ⚠出すのは**理由と件数だけ**(住所・地番は出さない=秘匿)。
 * ⚠並びは最初に出てきた順(件数で並べ替えない)。同じ選択なら毎回同じ文になり、
 *   利用者が「さっきと同じ話か」を見分けられる。
 */
export function describeSkipReasons(
  codes: Array<string | null | undefined>,
): string {
  const counts = new Map<string, number>();
  for (const code of codes) {
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, n]) => `${BULK_SKIP_REASON_LABEL[code] ?? code}: ${n}件`)
    .join(" / ");
}

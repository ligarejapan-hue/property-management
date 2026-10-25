/**
 * Excel の顧客管理表の「担当者」の列(例「勝地」)を、システムのユーザー(担当者)に当てる。純関数。
 * 従業員の指摘⑨(2026-10-25)「エクセルから入れたデータに担当者の振り分けをしてほしい」。
 *
 * ⚠**1人に決まるときだけ**当てる(迷ったら当てない=画面で人が選ぶ)。
 *   ①空白を除いた氏名がそのまま同じ → その人
 *   ②表の値が氏名の頭(名字だけ)・または氏名が表の値の頭 → それが1人だけならその人
 *   2人以上に当たる(同じ名字)・誰にも当たらない → null
 * ⚠比べるのは空白を除き NFKC で揃えた文字だけ(読み仮名・あだ名の推測はしない)。
 */

export interface AssigneeCandidate {
  id: string;
  name: string;
}

function norm(s: string): string {
  return s.normalize("NFKC").replace(/[\s　]/g, "").replace(/(様|さん)$/, "");
}

export function matchAssignee(label: string | null | undefined, users: readonly AssigneeCandidate[]): string | null {
  const key = norm(label ?? "");
  if (key === "") return null;
  const named = users.map((u) => ({ id: u.id, n: norm(u.name) })).filter((u) => u.n !== "");
  const exact = named.filter((u) => u.n === key);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const partial = named.filter((u) => u.n.startsWith(key) || key.startsWith(u.n));
  return partial.length === 1 ? partial[0].id : null;
}

/** 担当者の列として読む見出し(空白を除いて比べる)。form_text=「担当者」・columns=「担当者氏名」。 */
export const ASSIGNEE_COLUMN_HEADERS: readonly string[] = ["担当者", "担当者氏名", "担当"];

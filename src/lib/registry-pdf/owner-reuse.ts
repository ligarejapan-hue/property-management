/**
 * 住所の無い所有者を、**その物件に既に紐づいている**所有者から再利用してよいかの判定（純関数）。
 *
 * なぜ要るか（@codex #394 R6 P2）: 謄本PDFの保存は取込処理の**最後**にあり、保存に失敗しても
 * 取込自体は成功扱い（警告のみ）。つまり「PDFだけ入らなかったのでやり直す」が現実に起きる。
 * ところが住所の無い所有者は「名前だけでの自動統合はしない」規則のため、やり直すたびに
 * 新しい所有者として作られ、**同じ物件に同じ人が並ぶ**。
 *
 * ⚠**グローバルな「名前だけの統合」は従来どおり禁止**。別々の物件に居る同姓同名は
 *   別人であり得るため、統合すると DM の宛先などが混ざる。
 * ⚠ここで再利用してよいのは**その物件に既に紐づいている**所有者だけ。1つの物件に
 *   同姓同名の別人が両方所有者として載る状況は実務上まず無く、あっても住所の無い
 *   謄本の記載からは区別できない。
 */
import { normalizeName } from "@/lib/normalize";

export interface LinkedOwnerCandidate {
  id: string;
  name: string;
  address: string | null;
  isArchived: boolean;
  corporateNumber: string | null;
}

/**
 * @param candidates その物件に紐づいている所有者（アーカイブ済みを含んでよい）
 * @param name       謄本から読んだ所有者名（住所が無いもの）
 * @returns 再利用してよい所有者。無ければ null（＝従来どおり新規作成）
 */
export function pickReusableAddresslessOwner(
  candidates: LinkedOwnerCandidate[],
  name: string,
): LinkedOwnerCandidate | null {
  const target = normalizeName(name);
  // ⚠空同士を一致させない（名前が読めていない所有者を巻き込まないため）。
  if (!target) return null;
  const matches = candidates.filter(
    (c) => !c.isArchived && normalizeName(c.name) === target,
  );
  if (matches.length === 0) return null;
  // 前回の取込で作られたのは**住所なし**なので、それを優先する。
  // 同名が複数居る場合も、先頭1件に決めて挙動を一定にする。
  return matches.find((c) => (c.address ?? "").trim() === "") ?? matches[0];
}

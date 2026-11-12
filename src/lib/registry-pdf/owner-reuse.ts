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
import { normalizeAddress, normalizeName } from "@/lib/normalize";
import { foldVariantChar } from "@/lib/name-variants";

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

/**
 * 同じ物件の中で「同じ人」かを比べる名前のキー。NFKC・空白を消す(normalizeName)→
 * 異体字をそろえる(name-variants)→英字は小文字。
 * ⚠**同じ物件の中だけで使う**。物件をまたぐ照合(名前+住所)には使わない。
 */
export function samePropertyNameKey(name: string): string {
  return Array.from(normalizeName(name)).map(foldVariantChar).join("").toLowerCase();
}

/**
 * 同じ物件に既に紐づいている所有者から、**名前が同じ人**を選ぶ(住所は見ない・純関数)。
 *
 * なぜ(2026-11-12 発注者決定): 取り込みは「名前+住所が同じ」ときだけ既存の所有者を
 * 使い回す。謄本には同じ人が住所違いで2回載ることがある(持分を別の時期に取得し、その間に
 * 引っ越したが住所の変更登記をしていない)ため、同じ物件に同じ人が2人できていた
 * (本番で285組・DM が古い住所にも出る)。1つの物件に同姓同名の別人が共有で載ることは
 * 実務上まず無いので、同じ物件の中では名前だけで同じ人とみなす。
 * ⚠**物件をまたぐ照合は従来どおり名前+住所**(別の物件の同姓同名は別人であり得る)。
 *
 * @param candidates その物件に紐づいている所有者(古い順に渡す=先頭を選ぶ)
 * @returns 使い回す所有者。無ければ null
 */
export function pickSamePropertyOwner<T extends { name: string; isArchived: boolean }>(
  candidates: readonly T[],
  name: string,
): T | null {
  const target = samePropertyNameKey(name);
  // ⚠空同士を一致させない(名前が読めていない所有者を巻き込まない)。
  if (!target) return null;
  return candidates.find((c) => !c.isArchived && samePropertyNameKey(c.name) === target) ?? null;
}

/**
 * 同じ物件で同じ人を使い回したとき、登記上の住所を新しい行の住所に替えるか(純関数)。
 *
 * - 替えるのは**この取り込みの中で作った人**だけ。謄本は古い登記から順に載るので、
 *   後の行の住所のほうが新しい(発注者決定 11-12「後から入った方の住所を残す」)。
 * - 前からいる人の住所は替えない(人が手で直した住所かもしれない)。空欄の穴埋めは
 *   従来の処理(ペアで補完)に任せる。
 * - 郵便番号は住所と組で替える(別の場所の郵便番号を残さない)。
 *
 * @returns 書き込む { zip, address }。替えないときは null
 */
export function planSamePropertyAddressReplace(
  current: { zip: string | null; address: string | null },
  incoming: { zip: string | null; address: string | null },
  createdInThisRun: boolean,
): { zip: string | null; address: string } | null {
  if (!createdInThisRun) return null;
  const nextAddress = incoming.address?.trim() ? incoming.address : null;
  if (!nextAddress) return null;
  if (!current.address?.trim()) return null;
  if (normalizeAddress(current.address) === normalizeAddress(nextAddress)) return null;
  return { zip: incoming.zip?.trim() ? incoming.zip : null, address: nextAddress };
}

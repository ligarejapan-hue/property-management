/**
 * 貼り付けて物件化で、**コメント・ご要望などの自由記述を所有者の備考へ**入れる(2026-10-24 従業員の指摘)。
 *
 * ⚠なぜ物件の備考ではなく所有者の備考か:
 *   自由記述は何が書かれるか分からないので、物件の備考(物件を見られる人全員に出る)へは入れない
 *   (owner-personal-info.ts の withheld)。所有者の備考は owner_note の表示レベルで守られる欄で、
 *   Excel の顧客管理表の取込もコメント・見込度などをここへ入れている(composeLeadOwnerNote)。
 * ⚠入れるのは**理由が unclassified(安全と確定できなかった自由記述)のものだけ**。
 *   見出し(電話・メール・住所・氏名・年齢・番号…)や値の形(電話・メール・住所・人名)で
 *   伏せたものは、それぞれ専用の欄と権限があるので所有者の備考へまとめない
 *   (備考を見られるだけの人に電話番号が見える道を作らない)。今までどおり画面に出して人が移す。
 * ⚠ Prisma / next を import しない(純関数)。
 */
import type { PasteDraft } from "./types";

/** 所有者の備考の1行目(どこから入ったかを示す)。 */
export const PASTE_IMPORT_OWNER_NOTE_PREFIX = "貼り付け取込:";

type Withheld = PasteDraft["withheldFromNote"][number];

/**
 * 文の中に電話番号(区切りを挟んで数字10桁以上)やメールアドレス(@)を含むか。
 * ⚠値の形の判定(looksLikePhoneNumber など)は値**全体**が電話・メールのときだけ当たるので、
 *   「折り返しは090-1234-5678まで」のような文は unclassified になる(内部レビュー P2)。
 *   所有者の備考は見られても電話・メールは見られない人がいるので、そういう文は自動で入れず人が移す。
 */
function containsContact(value: string): boolean {
  const v = value.normalize("NFKC");
  if (v.includes("@")) return true;
  return /[0-9](?:[\s\-‐−ー().]*[0-9]){9,}/.test(v);
}

/** 所有者の備考へ入れる項目か(自由記述=unclassified で、電話・メールを含まないものだけ)。 */
export function goesToOwnerNote(w: Withheld): boolean {
  return w.reason === "unclassified" && !containsContact(w.value);
}

/**
 * 所有者の備考に入れる文を組み立てる。入れる項目が無ければ null。
 * 形: 1行目 `貼り付け取込:`、続けて `見出し: 値` を1項目1行。
 */
export function composePasteOwnerNote(draft: Pick<PasteDraft, "withheldFromNote">): string | null {
  const lines = draft.withheldFromNote
    .filter(goesToOwnerNote)
    .map((w) => `${w.label}: ${w.value.trim()}`)
    .filter((l) => !l.endsWith(": "));
  if (lines.length === 0) return null;
  return [PASTE_IMPORT_OWNER_NOTE_PREFIX, ...lines].join("\n");
}

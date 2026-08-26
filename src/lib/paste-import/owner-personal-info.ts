/**
 * 辞書に無かった見出しのうち、**所有者の個人情報にあたるもの**を見分ける純関数。
 *
 * ⚠なぜ要るか(@codex PR#414 11巡目 ①):
 *   辞書に無い見出し(例 `携帯電話` `連絡先住所`)の値は備考へまとめて入り、
 *   `Property.note` に保存される。**`Property.note` は所有者の項目別マスクを
 *   通らずに表示される**ため、
 *     ・`owner_phone` の権限が無い利用者でも電話番号を保存できる
 *     ・しかもそれは物件を見られる**全員**に見える
 *   となり、**同じPRで入れた項目別権限チェックを備考が迂回していた**。
 *   これは「情報の損失」ではなく「**権限体系の迂回**」の問題。
 *
 * ⚠**捨てない**。ここで見分けたものは備考へ入れないだけで、確認画面には出す
 *   (「この項目は備考に入れません。必要なら適切な欄へ移してください」)。
 *   人が見て判断できる状態は保つ。
 *
 * ⚠ Prisma / next / node:fs を import しないこと(純関数を保つため)。
 */

/** 判定に使う見出しの語(所有者の個人情報を指すもの)。 */
const OWNER_PII_LABEL_WORDS: readonly string[] = [
  // 連絡先
  "電話",
  "TEL",
  "PHONE",
  "携帯",
  "けいたい",
  "FAX",
  "ファックス",
  "メール",
  "MAIL",
  "EMAIL",
  "アドレス",
  "LINE",
  // 住所
  "住所",
  "現住所",
  "居所",
  "郵便番号",
  "〒",
  // 氏名・本人属性
  "氏名",
  "名前",
  "お名前",
  "ご芳名",
  "フリガナ",
  "ふりがな",
  "カナ",
  "年齢",
  "生年月日",
  "性別",
];

/**
 * 「物件のこと」を指す語。⚠これを含む見出しは所有者の個人情報とみなさない。
 * 例: `物件住所` `物件所在地` は**物件**の住所であって所有者の連絡先ではない。
 */
const PROPERTY_SCOPE_WORDS: readonly string[] = ["物件", "所在地", "土地", "建物"];

/** 比較用に見出しを整える(全角/半角・空白・大文字小文字を吸収)。 */
function normalizeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .toUpperCase();
}

/** 電話番号らしい値か(国内の固定/携帯。区切りは任意)。 */
export function looksLikePhoneNumber(value: string): boolean {
  const digits = value.normalize("NFKC").replace(/[^0-9]/g, "");
  if (digits.length < 10 || digits.length > 11) return false;
  // 数字と区切り記号だけで出来ていること(住所や金額を拾わない)。
  return /^[0-9+\-()\s.　]+$/.test(value.normalize("NFKC"));
}

/** メールアドレスらしい値か。 */
export function looksLikeEmailAddress(value: string): boolean {
  const v = value.normalize("NFKC").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export type OwnerPersonalInfoReason = "label" | "value";

export interface OwnerPersonalInfoVerdict {
  /** 所有者の個人情報にあたる＝**備考へ入れない**。 */
  isOwnerPersonalInfo: boolean;
  /** なぜそう判断したか(見出しの語か、値の形か)。該当しなければ null。 */
  reason: OwnerPersonalInfoReason | null;
}

/**
 * 見出しと値の**両方**を手がかりに、所有者の個人情報かを判定する。
 * どちらか一方でも当たれば「個人情報」とみなす(安全側)。
 */
export function judgeOwnerPersonalInfo(
  label: string,
  value: string,
): OwnerPersonalInfoVerdict {
  const normalized = normalizeLabel(label);

  // ⚠まず「物件のこと」を指す見出しを外す。`物件住所` を所有者の住所と
  //   取り違えると、落とすべきでないものまで備考から消える。
  const aboutProperty = PROPERTY_SCOPE_WORDS.some((w) =>
    normalized.includes(normalizeLabel(w)),
  );

  if (!aboutProperty) {
    const hit = OWNER_PII_LABEL_WORDS.some((w) =>
      normalized.includes(normalizeLabel(w)),
    );
    if (hit) return { isOwnerPersonalInfo: true, reason: "label" };
  }

  // 見出しで分からなくても、**値の形**が電話番号・メールアドレスなら落とす
  //   (`ご連絡先` `お問い合わせ先` のような見出しはいくらでも増える)。
  if (looksLikePhoneNumber(value) || looksLikeEmailAddress(value)) {
    return { isOwnerPersonalInfo: true, reason: "value" };
  }

  return { isOwnerPersonalInfo: false, reason: null };
}

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
  "名義人",
  "ご芳名",
  "フリガナ",
  "ふりがな",
  "カナ",
  "年齢",
  "生年月日",
  "性別",
];

/**
 * 「物件のこと」を指す語。これを含む見出しは、原則として所有者の個人情報とみなさない。
 * 例: `物件住所` `物件所在地` は**物件**の住所であって所有者の連絡先ではない。
 *
 * ⚠**ただしこの例外は、それ自体が穴になる**(@codex PR#414 12巡目 ②)。
 *   `物件所有者氏名: 山田太郎` は「物件」を含むため除外が先に効き、
 *   値も電話/メールの形ではないので、**氏名がそのまま備考へ入って**いた
 *   (＝所有者の項目別マスクの外に出る)。
 *   → 下の OWNER_SCOPE_WORDS を**先に**見て、所有者を明示する語があれば
 *   物件系の語があっても**所有者側を優先**する。
 *   (社内の恒久ルール「防御を入れるとその防御自体の抜けを突かれる」の実例。)
 */
const PROPERTY_SCOPE_WORDS: readonly string[] = ["物件", "所在地", "土地", "建物"];

/**
 * 「所有者のこと」を明示する語。**物件系の語より優先**する。
 * ここに当たれば、見出しに「物件」が含まれていても所有者側として扱う。
 */
const OWNER_SCOPE_WORDS: readonly string[] = [
  "所有者",
  // 人を指す語(@codex PR#414 13巡目 ①)。`お客様所在地` `売主様ご住所` のような
  // 見出しは、所有者そのものを名指ししていないのに人の情報を持つ。
  "お客様",
  "客様",
  "依頼者",
  "ご依頼",
  "申込",
  "売主",
  "買主",
  "相続人",
  "代理人",
  "担当者様",
  "様",
  "名義人",
  "名義",
  "持ち主",
  "持主",
  "本人",
  "氏名",
  "名前",
  "フリガナ",
  "ふりがな",
  "カナ",
];

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


// ---------------------------------------------------------------------------
// ⚠**既定の向きを反転する**(@codex PR#414 13巡目 ①)。
//
// R11(物件語の除外が広すぎ) → R12(所有者語の優先) → R13(お客様/依頼者が列挙に無い)と、
// **3巡続けて列挙の穴を1語ずつ突かれた**。語を足すだけでは、次は別の言い回しで同じ
// 指摘が来る。**危険を数え上げる方式そのものが誤り**だった。
//
// 社内の恒久ルール「伏せ字は許可リスト方式 ― 危険を除くのではなく、
// **安全なものだけで組み立てる**」に合わせ、判定を次の向きにする:
//   ①「安全と確定できる」なら備考へ通す
//   ②それ以外は、値が**住所・電話・メール・人名のいずれかの形**に見えたら withheld
//
// ⚠代償は承知のうえ: 非PIIの項目が誤って withheld になることが増える。しかし
//   withheld は**画面に表示され、人が備考へ手で移せる**。
//   **過剰に伏せる誤りは回復可能、漏らす誤りは回復不能**。倒す向きはこちら。
// ---------------------------------------------------------------------------

/** 都道府県。住所らしさの判定に使う(先頭一致)。 */
const PREFECTURES: readonly string[] = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

/**
 * 住所らしい値か。
 * ⚠**粗くてよい**。過剰に引っかかっても withheld(＝画面に出して人が移せる)に
 *   なるだけで、漏らすより害が小さい。
 */
export function looksLikeAddress(value: string): boolean {
  const v = value.normalize("NFKC").replace(/[\s]/g, "");
  if (v === "") return false;
  if (PREFECTURES.some((p) => v.startsWith(p))) return true;
  if (v.includes("丁目") || v.includes("番地")) return true;
  // 市区町村のいずれかを含み、かつ数字がある(「◯◯市1-2-3」の類)。
  if (/[市区町村]/.test(v) && /[0-9]/.test(v)) return true;
  return false;
}

/**
 * 人名らしい値か。
 * ⚠短い漢字/かなの塊は氏名のことが多い。**定型語(下の安全な値)を先に除く**。
 */
export function looksLikePersonName(value: string): boolean {
  const v = value.normalize("NFKC").replace(/[\s]/g, "");
  if (v.length < 2) return false;
  if (/[0-9A-Za-z]/.test(v)) return false;
  const KANA_ONLY = /^[ぁ-んァ-ヶー・]+$/;
  const KANA_OR_KANJI = /^[々〆〇ぁ-んァ-ヶー・㐀-䶿一-鿿豈-﫿]+$/;
  // かなだけの氏名は長くなりがち(ヤマダタロウ)。漢字を含むものは短い。
  if (KANA_ONLY.test(v)) return v.length <= 10;
  return v.length <= 5 && KANA_OR_KANJI.test(v);
}

/**
 * **明らかに個人情報ではない**と確定できる値(許可リスト)。
 * ⚠ここに載っているものだけが「安全と確定」。増やすのは構わないが、
 *   **人名・住所・連絡先になりうるものは絶対に載せない**。
 */
const DEFINITELY_SAFE_VALUES: ReadonlySet<string> = new Set([
  "なし", "無し", "無", "ない",
  "あり", "有り", "有", "ある",
  "不明", "未定", "未記入", "未入力", "その他",
  "本人", "本人所有", "共有", "単独",
  "売却", "賃貸", "建替", "解体", "相談", "検討中",
  "-", "ー", "−", "―", "‐", "—", "*", "",
]);

/** 値が「明らかに個人情報ではない」と確定できるか。 */
export function isDefinitelyNonPersonalValue(value: string): boolean {
  const v = value.normalize("NFKC").replace(/[\s]/g, "");
  if (v === "") return true;
  if (DEFINITELY_SAFE_VALUES.has(v)) return true;
  // 数値だけ(単位付きを含む)。面積・金額・年数の類。
  if (/^[0-9]+(\.[0-9]+)?[^0-9]{0,4}$/.test(v) && !/[市区町村丁目番地]/.test(v)) {
    return true;
  }
  return false;
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

  // ⚠**所有者・人を指す語を先に見る**(12巡目 ②)。`物件所有者氏名` のように
  //   両方の語を含む見出しで物件系の除外が先に効くと、氏名が備考へ素通りする。
  const aboutOwner = OWNER_SCOPE_WORDS.some((w) =>
    normalized.includes(normalizeLabel(w)),
  );

  // ---- ① 見出しが個人情報の項目だと分かるなら、そこで確定 ----
  const propertyConfirmed =
    !aboutOwner &&
    PROPERTY_SCOPE_WORDS.some((w) => normalized.includes(normalizeLabel(w)));

  if (!propertyConfirmed) {
    const hit = OWNER_PII_LABEL_WORDS.some((w) =>
      normalized.includes(normalizeLabel(w)),
    );
    if (hit) return { isOwnerPersonalInfo: true, reason: "label" };
  }

  // ---- ② 「安全と確定できる」なら備考へ通す ----
  // ⚠ここから先が**既定の向きの反転**(13巡目 ①)。安全と言い切れるのは
  //   (a) 見出しが**物件系と確定**できる(物件語を含み、所有者・人物語を含まない)
  //   (b) 値が**明らかに非個人情報**(許可リスト・数値のみ など)
  //   の2つだけ。
  if (propertyConfirmed) return { isOwnerPersonalInfo: false, reason: null };
  if (isDefinitelyNonPersonalValue(value)) {
    return { isOwnerPersonalInfo: false, reason: null };
  }

  // ---- ③ 安全と確定できないものは、値の形で見る ----
  // ⚠住所・電話・メール・人名のいずれかに見えたら withheld。
  //   粗い判定で過剰に引っかかっても、withheld は画面に出て人が備考へ移せる。
  //   **過剰に伏せる誤りは回復可能、漏らす誤りは回復不能**。
  if (
    looksLikeAddress(value) ||
    looksLikePhoneNumber(value) ||
    looksLikeEmailAddress(value) ||
    looksLikePersonName(value)
  ) {
    return { isOwnerPersonalInfo: true, reason: "value" };
  }

  return { isOwnerPersonalInfo: false, reason: null };
}

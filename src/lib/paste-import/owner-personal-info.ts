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
 * **物件の所在を指すと確定できる見出し**（正規化後の**完全一致**のみ）。
 *
 * ⚠部分文字列で「物件系」と確定してはいけない(@codex PR#414 14巡目 ②)。
 *   `勤務先所在地` `会社所在地` は「所在地」を含むだけで物件のことではなく、
 *   **勤務先の住所が値の形の判定に到達する前に**備考へ素通りしていた。
 *   13巡目で向きは反転したのに、「確定」の定義が部分文字列のままで、
 *   **反転が判定の芯まで届いていなかった**。
 * ⚠ここに載せてよいのは「物件の所在**だけ**を意味する」と言い切れる見出しに限る。
 *   増やすときは、その語が人の住所を指す複合語になりえないかを必ず考えること。
 */
const PROPERTY_LOCATION_LABELS_EXACT: ReadonlySet<string> = new Set(
  [
    "物件所在地",
    "物件の所在地",
    "物件所在",
    "物件の所在",
    "物件住所",
    "物件の住所",
    "所在地",
    "所在",
    "土地所在地",
    "土地の所在地",
    "建物所在地",
    "建物の所在地",
  ].map((l) => l.normalize("NFKC").replace(/[\s　]/g, "").toUpperCase()),
);

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
  // 建物の構造・現況(人名にも住所にもなりえない定型語)
  "木造", "鉄骨造", "軽量鉄骨造", "鉄筋コンクリート造", "ブロック造",
  "更地", "空家", "空き家", "居住中", "賃貸中", "空室", "自己居住",
  "-", "ー", "−", "―", "‐", "—", "*", "",
]);

/**
 * 人名らしい値か。
 * ⚠短い漢字/かなの塊は氏名のことが多い。**定型語(下の安全な値)を先に除く**。
 */
export function looksLikePersonName(value: string): boolean {
  const v = value.normalize("NFKC").replace(/[\s]/g, "");
  if (v.length < 2) return false;
  // ⚠**許可リストの定型語は人名とみなさない**。
  //   14巡目で「形の判定を値の許可リストより先に」評価する順序にしたため、
  //   許可リストを後段の逃げ道にはできない。代わりに、
  //   **人名らしさの定義そのもの**から定型語を除く(許可リストは
  //   「人名・住所・連絡先になりえないと人が確認した閉じた集合」なので、
  //   ここで参照しても危険側へ倒れない。テストで固定してある)。
  if (DEFINITELY_SAFE_VALUES.has(v)) return false;
  if (/[0-9A-Za-z]/.test(v)) return false;
  const KANA_ONLY = /^[ぁ-んァ-ヶー・]+$/;
  const KANA_OR_KANJI = /^[々〆〇ぁ-んァ-ヶー・㐀-䶿一-鿿豈-﫿]+$/;
  // かなだけの氏名は長くなりがち(ヤマダタロウ)。漢字を含むものは短い。
  if (KANA_ONLY.test(v)) return v.length <= 10;
  return v.length <= 5 && KANA_OR_KANJI.test(v);
}

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

  // ⚠所有者・人を指す語を先に見る(12巡目 ②)。`物件所有者氏名` のように
  //   両方の語を含む見出しで物件系が先に効くと、氏名が備考へ素通りする。
  const aboutOwner = OWNER_SCOPE_WORDS.some((w) =>
    normalized.includes(normalizeLabel(w)),
  );

  // ⚠物件系と「確定」できるのは**完全一致**のときだけ(14巡目 ②)。
  //   部分一致だと `勤務先所在地` `会社所在地` まで安全側に倒れる。
  const propertyConfirmed = !aboutOwner && PROPERTY_LOCATION_LABELS_EXACT.has(normalized);

  // ---- ① 見出しが個人情報の項目だと分かるなら、そこで確定 ----
  if (!propertyConfirmed) {
    const hit = OWNER_PII_LABEL_WORDS.some((w) =>
      normalized.includes(normalizeLabel(w)),
    );
    if (hit) return { isOwnerPersonalInfo: true, reason: "label" };
  }

  // ---- ② 見出しで「安全と確定」できるならここで通す ----
  if (propertyConfirmed) return { isOwnerPersonalInfo: false, reason: null };

  // ---- ③ **値の形を、値の許可リストより先に見る**(14巡目 ①) ----
  // ⚠順序が逆だと、`緊急連絡先: 09012345678` が「数値のみ＝安全」で通ってしまい、
  //   電話形状の判定に**到達しない**。危険な形を先に落とし、
  //   そこを通らなかったものだけを許可リストに掛ける。
  //   (この順序は __tests__ で pin してある。入れ替えると必ず落ちる。)
  if (
    looksLikePhoneNumber(value) ||
    looksLikeEmailAddress(value) ||
    looksLikeAddress(value) ||
    looksLikePersonName(value)
  ) {
    return { isOwnerPersonalInfo: true, reason: "value" };
  }

  // ---- ④ 値が明らかに非個人情報（許可リスト・数値のみ）なら通す ----
  if (isDefinitelyNonPersonalValue(value)) {
    return { isOwnerPersonalInfo: false, reason: null };
  }

  return { isOwnerPersonalInfo: false, reason: null };
}

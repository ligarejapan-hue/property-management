// 法人番号（国税庁マイナンバー法人番号 / 13桁）の検出・正規化ヘルパー。
//
// 重要な不変条件:
// - 採用する形式は 13桁数字のみ。12桁（会社法人等番号）はラベル付きでも本ヘルパーでは採用しない
//   （Phase A は厳格に 13桁ベース。Phase D 以降でラベル付き12桁を扱うなら別ヘルパーで対応）。
// - 全角数字 / 空白 / ハイフン（半角 - / 全角 ー / 全角ハイフン − ─ ‐ など）は正規化で除去する。
// - ラベル付き「法人番号: 1234567890123」のような形式は label-aware に抽出する。
// - 電話番号 / 14桁以上の連続数字 / 13桁ハイフン区切りの電話番号風（13桁未満になる）は誤検出しない。

const FULLWIDTH_TO_HALFWIDTH_DIGIT_OFFSET = "０".charCodeAt(0) - "0".charCodeAt(0);

const HYPHEN_LIKE_CHARS = /[\-‐‑‒–—―ー－−─]/g;
const WHITESPACE_CHARS = /\s+/g;
const ZENKAKU_DIGITS_RE = /[０-９]/g;

const CORPORATE_NUMBER_LENGTH = 13;

/**
 * 入力文字列を「半角数字のみ」に正規化する。
 * 全角数字 → 半角数字、ハイフン類・空白を除去。
 * 入力が null/undefined/空のときは null を返す。
 */
function toHalfwidthDigitsOnly(input: string): string {
  return input
    .replace(ZENKAKU_DIGITS_RE, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_TO_HALFWIDTH_DIGIT_OFFSET),
    )
    .replace(HYPHEN_LIKE_CHARS, "")
    .replace(WHITESPACE_CHARS, "");
}

/**
 * 法人番号として有効な 13桁数字に正規化する。
 *
 * - null / undefined / 空 → null
 * - ハイフン・空白・全角数字を吸収後、13桁数字なら採用、それ以外は null
 * - 12桁 / 14桁以上 → null
 * - 数字以外を含む / 桁数不一致 → null
 */
export function normalizeCorporateNumber(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const digits = toHalfwidthDigitsOnly(trimmed);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length !== CORPORATE_NUMBER_LENGTH) return null;
  return digits;
}

// ラベル付き「法人番号 / 会社法人等番号 / 法人No. …」+ 区切り + 13桁(ハイフン/全角混じり許容)。
//
// 値捕捉から「空白」を除外する(Codex P1):
//   旧 regex は値捕捉クラスに `\s` を含めていたため、ラベル付き 12桁(会社法人等番号)の
//   値の直後に空白を挟んで数字で始まる住所断片が続くと、空白を跨いで
//   「12桁ラベル値 + 住所先頭の数字」= 13桁 を合成し、擬似13桁法人番号として誤検出した
//   (例: "会社法人等番号 0200-01-012345 1丁目" → 捕捉 "0200-01-012345 1" → normalize で
//    "0200010123451"(13桁)。住所の "1" を吸い込み、除去すると住所が "丁目" に壊れる)。
//   値は「数字とハイフン類のみで連続するラン」に限定し、空白で区切られた別トークンを
//   跨がない(空白手前で値が完結する)。これにより 12桁ラベル値は 13桁に化けず、後段の
//   12桁検出器が正しく拾える。正当な 13桁値(連続/ハイフン区切り)の検出は不変。
//   右境界 `(?![0-9０-９\-‐‑‒–—―ー－−─])` でラン直後の数字/ハイフン連結を拒否し、
//   長い ID の先頭13桁を部分採用しない(従来方針を維持)。
const LABELED_CORPORATE_NUMBER_RE =
  /(?:法人番号|会社法人等番号|法人No\.?|法人ナンバー|Corporate Number|corporateNumber|corporate_number)[\s:：=]*([0-9０-９][0-9０-９\-‐‑‒–—―ー－−─]{11,30})(?![0-9０-９\-‐‑‒–—―ー－−─])/gi;

const BARE_CORPORATE_NUMBER_RE = /(?<![\d-])(\d{13})(?!\d)/g;

// 裸の全角数字 13桁にマッチする正規表現。検出(extractCorporateNumbersFromText)と
// cleanup 除去(removeCorporateNumbersFromText)の両方で使う。BARE_CORPORATE_NUMBER_RE は
// 半角 \d のみで全角数字列を拾えないため別途用意する。境界では半角/全角数字に加え
// HYPHEN_LIKE_CHARS と同じ各種ハイフン(全角 － / 数学マイナス − / ダッシュ類 / ー 等)も
// 除外し、"…－45" のようなハイフン連結 ID の先頭13桁を誤検出/誤除去しない。
const BARE_FULLWIDTH_CORPORATE_NUMBER_RE = /(?<![0-9０-９\-‐‑‒–—―ー－−─])([０-９]{13})(?![0-9０-９\-‐‑‒–—―ー－−─])/g;

/**
 * 入力テキストから法人番号候補を抽出する。
 *
 * 抽出ルール:
 * 1. ラベル付き「法人番号: 1234567890123」を優先抽出（区切り文字混じり許容）。
 * 2. ラベルなしの裸 13桁数字は単語境界マッチで抽出（前後に数字・ハイフンが連結していないこと）。
 *
 * 抽出後は normalizeCorporateNumber で 13桁検証を再度通すため、
 * 桁数が合わないラベル付き候補（例: 12桁）は最終的に除外される。
 * 戻り値は重複除去済み（Set 経由）。
 */
export function extractCorporateNumbersFromText(input: string | null | undefined): string[] {
  if (input == null) return [];
  const text = input;
  if (text.trim() === "") return [];

  const found = new Set<string>();

  for (const match of text.matchAll(LABELED_CORPORATE_NUMBER_RE)) {
    const normalized = normalizeCorporateNumber(match[1]);
    if (normalized) found.add(normalized);
  }

  for (const match of text.matchAll(BARE_CORPORATE_NUMBER_RE)) {
    const normalized = normalizeCorporateNumber(match[1]);
    if (normalized) found.add(normalized);
  }

  // ラベルなしの裸 全角13桁(例 "株式会社○○ １２３４５６７８９０１２３")も抽出する。
  for (const match of text.matchAll(BARE_FULLWIDTH_CORPORATE_NUMBER_RE)) {
    const normalized = normalizeCorporateNumber(match[1]);
    if (normalized) found.add(normalized);
  }

  return Array.from(found);
}

/**
 * tidy: 除去後の文字列を整える。
 *  - 連続する空白(半角/全角/タブ)を半角1つへ畳む
 *  - 先頭/末尾の孤立した区切り(、,／/・)と周囲の空白を除去
 *  - 前後 trim
 */
function tidyAfterCorporateRemoval(s: string): string {
  let r = s.replace(/[ 　\t]+/g, " ");
  r = r.replace(/^\s*[、,／/・]\s*/u, "");
  r = r.replace(/\s*[、,／/・]\s*$/u, "");
  return r.trim();
}

// cleanup の破壊的除去では左右とも、HYPHEN_LIKE_CHARS と同じ各種ハイフンを除外する。
// 共有の BARE_CORPORATE_NUMBER_RE は右境界が (?!\d) のみで "1234567890123-45"(全角 － 含む)の
// 先頭13桁にマッチしてしまい、cleanup で削ると "-45" / "－45" の壊れた残骸になる。
// 検出側（extractCorporateNumbersFromText が使う BARE_CORPORATE_NUMBER_RE）は
// import/candidate と共有のため変更せず、cleanup 専用にこの厳格版を使う。
const BARE_CORPORATE_NUMBER_RE_FOR_CLEANUP = /(?<![\d\-‐‑‒–—―ー－−─])(\d{13})(?![\d\-‐‑‒–—―ー－−─])/g;

/**
 * テキストから「指定した 13桁法人番号」の混入を除去する。
 *  - ラベル付き(法人番号: など)はラベルごと、裸 13桁はその数列を除去する。
 *  - 除去対象は normalize 後の値が numbersToRemove に含まれるものだけ
 *    (extractCorporateNumbersFromText と同じ regex を使うため検出と除去の対象が一致する)。
 *  - 裸の全角数字 13桁も除去対象となる(normalize により同値と判定)。
 *  - 除去後は tidyAfterCorporateRemoval で空白・孤立区切りを整える。
 *  - input が null/undefined → null。numbersToRemove が空 → input をそのまま返す。
 */
export function removeCorporateNumbersFromText(
  input: string | null | undefined,
  numbersToRemove: string[],
): string | null {
  if (input == null) return null;
  if (numbersToRemove.length === 0) return input;
  const targets = new Set(numbersToRemove);

  // 実際に除去が起きたかを追跡する。対象番号を含まないフィールドは tidy せず原文を返し、
  // 無関係な空白の正規化などで「変更扱い」にしない(Codex P2: 混入除去が無関係データを書き換えない)。
  let removed = false;
  const strip = (full: string, num: string): string => {
    const normalized = normalizeCorporateNumber(num);
    if (normalized && targets.has(normalized)) {
      removed = true;
      return "";
    }
    return full;
  };

  // 1. ラベル付き(ラベル+区切り+番号)を除去
  let result = input.replace(LABELED_CORPORATE_NUMBER_RE, strip);
  // 2. 裸 13桁(半角)を除去（右側も hyphen を除外する厳格版＝ID "…-45" の先頭13桁を壊さない）
  result = result.replace(BARE_CORPORATE_NUMBER_RE_FOR_CLEANUP, strip);
  // 3. 裸 13桁(全角)を除去
  result = result.replace(BARE_FULLWIDTH_CORPORATE_NUMBER_RE, strip);

  return removed ? tidyAfterCorporateRemoval(result) : input;
}

// ───────────────────────────────────────────────────────────────────────────
// 会社法人等番号(12桁 / 登記の番号)= 国税庁の法人番号(13桁)とは別物。
//
// 重要な不変条件(13桁ロジックとの分離):
//  - 採用形式は 12桁数字のみ。13桁(法人番号)は本ヘルパーでは採用しない(混同しない)。
//  - 13桁の検出/正規化/移送(corporateNumber 列)には一切干渉しない(別関数・別 regex)。
//  - 誤検出回避: 裸 12桁(電話番号 / マイナンバー等)は採用せず、ラベル付き
//    (会社法人等番号 / 法人等番号)のみを抽出・除去する。これは 13桁実装が裸検出を
//    許すのと比べ「より厳格」な方針(12桁は識別子としての特異性が低いため)。
//  - 全角数字 / 各種ハイフン / 空白は正規化で吸収する(13桁と同じ HYPHEN_LIKE_CHARS)。
// ───────────────────────────────────────────────────────────────────────────

const COMPANY_REGISTRY_NUMBER_LENGTH = 12;

/**
 * 会社法人等番号として有効な 12桁数字に正規化する。
 *
 * - null / undefined / 空 → null
 * - ハイフン・空白・全角数字を吸収後、12桁数字なら採用、それ以外は null
 * - 11桁以下 / 13桁以上 → null(13桁=法人番号は別物として弾く)
 * - 数字以外を含む → null
 */
export function normalizeCompanyRegistryNumber(
  input: string | null | undefined,
): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const digits = toHalfwidthDigitsOnly(trimmed);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length !== COMPANY_REGISTRY_NUMBER_LENGTH) return null;
  return digits;
}

// ラベル付き「会社法人等番号 / 法人等番号」+ 区切り + 12桁(ハイフン/全角/空白混じり許容)。
// 13桁を弾くため、最終的に normalizeCompanyRegistryNumber で 12桁検証を再度通す。
// (13桁の LABELED_CORPORATE_NUMBER_RE とは別 regex。"法人番号"(13桁用ラベル)は
//  ここには含めない=12桁抽出のラベルは会社法人等番号系に限定する。)
//
// 「ラベル後トークンをまるごと捕捉 → 厳格検証」方式(Codex 追加 P2 = 残り穴の根本対応):
//   従来は右境界に negative lookahead を継ぎ足していたが、捕捉ランがハイフンを内部許容する
//   ため、ラベル付き12桁の後に「ハイフン付きサフィックス」(例 020001012345-45A)が続くと
//   regex がバックトラックしてハイフン手前で12桁を確定し、normalize が妥当な会社法人等番号と
//   誤認 → 部分抽出/部分除去(壊れた残骸 "…-45A")を起こした。lookahead の継ぎ足しでは
//   いたちごっこになるため、方式自体を堅牢化する:
//
//   (a) ラベル(+区切り)直後の「連続する [半角数字/全角数字/ハイフン類/空白] のラン全体」を
//       greedy に捕捉する(部分採用させない)。末尾は数字で終える([0-9０-９] で締める)ことで
//       捕捉に区切りの残骸を含めない。
//   (b) 捕捉ランの直後の1文字が ASCII英字 / 半角数字 / 全角数字 / ハイフン類 のいずれかなら
//       その候補は採用しない(negative lookahead `(?![0-9０-９A-Za-z\-‐‑‒–—―ー－−─])`)。
//       ★ハイフン類も除外対象に含めるのが要点★。これによりトークンが12桁で完結せず別番号の
//       一部(…-45A / …-45)の場合、バックトラックでハイフン手前に逃げても境界で拒否され、
//       結局ラン全体(区切り除去で14桁化等)を捕捉 → normalize(12桁厳格検証)で弾かれる。
//   (c) 捕捉ランは区切りを除去後に normalizeCompanyRegistryNumber で「ちょうど12桁」のみ採用。
//       13桁以上・11桁以下・英字混入は不採用。
//
//   結果:
//     ・020001012345A          → 直後が英字 → 不採用
//     ・020001012345-45A       → ラン=...012345-45 を捕捉(直後英字Aを境界が拒否)→ 14桁 → 不採用
//     ・020001012345-45        → ラン=...012345-45 を捕捉 → 14桁 → 不採用
//     ・012345号               → 6桁 → 不採用(桁不足)
//     ・直後に更に数字         → 13桁以上 → 不採用
//     ・０２００−０１−０１２３４５  → 区切り除去で12桁完結 → 採用
//     ・020001012345(空白/和文/句点/文末) → 12桁完結 → 採用
//   さらに値捕捉から「空白」を除外する(Codex P1):
//     旧 regex は捕捉ランに `\s` を含めていたため、ラベル付き12桁の直後に空白を挟んで
//     数字住所が続くと(例 "会社法人等番号 0200-01-012345 1丁目")、空白を跨いで
//     "0200-01-012345 1"(13桁)を捕捉 → normalize(12桁検証)で弾かれ「検出漏れ」になった。
//     値は数字+ハイフン類の連続ランに限定し、空白で区切られた別トークンを跨がない。
//     これにより空白手前の 12桁で完結し、会社法人等番号として正しく検出/除去できる。
const LABELED_COMPANY_REGISTRY_NUMBER_RE =
  /(?:会社法人等番号|法人等番号)[\s:：=]*([0-9０-９](?:[0-9０-９\-‐‑‒–—―ー－−─]*[0-9０-９])?)(?![0-9０-９A-Za-z\-‐‑‒–—―ー－−─])/gi;

/**
 * 入力テキストから会社法人等番号(12桁)候補を抽出する。
 *
 * 抽出ルール:
 *  - ラベル付き(会社法人等番号 / 法人等番号)のみ抽出する(裸 12桁は誤検出回避で対象外)。
 *  - 抽出後 normalizeCompanyRegistryNumber で 12桁検証を通すため、13桁などは除外される。
 *  - 戻り値は重複除去済み(Set 経由)。
 */
export function extractCompanyRegistryNumbersFromText(
  input: string | null | undefined,
): string[] {
  if (input == null) return [];
  if (input.trim() === "") return [];

  const found = new Set<string>();
  for (const match of input.matchAll(LABELED_COMPANY_REGISTRY_NUMBER_RE)) {
    const normalized = normalizeCompanyRegistryNumber(match[1]);
    if (normalized) found.add(normalized);
  }
  return Array.from(found);
}

/**
 * テキストから「指定した 12桁会社法人等番号」のラベル付き混入を除去する。
 *
 *  - 除去対象はラベル付き(会社法人等番号 / 法人等番号 + 区切り + 番号)のみ。
 *    ラベルごと番号を除去し、孤立ハイフン等の残骸を残さない。
 *  - 除去対象は normalize 後の値が numbersToRemove に含まれるものだけ。
 *  - 裸 12桁は検出しない方針ゆえ除去もしない(無関係データを破壊しない)。
 *  - 除去後は tidyAfterCorporateRemoval で空白・孤立区切りを整える。
 *  - input が null/undefined → null。numbersToRemove が空 → input をそのまま返す。
 *  - 実際に除去が起きなければ tidy せず原文を返す(無関係な空白を変更しない)。
 */
export function removeCompanyRegistryNumbersFromText(
  input: string | null | undefined,
  numbersToRemove: string[],
): string | null {
  if (input == null) return null;
  if (numbersToRemove.length === 0) return input;
  const targets = new Set(numbersToRemove);

  let removed = false;
  const strip = (full: string, num: string): string => {
    const normalized = normalizeCompanyRegistryNumber(num);
    if (normalized && targets.has(normalized)) {
      removed = true;
      return "";
    }
    return full;
  };

  const result = input.replace(LABELED_COMPANY_REGISTRY_NUMBER_RE, strip);
  return removed ? tidyAfterCorporateRemoval(result) : input;
}

export interface OwnerLikeForCorporateDetection {
  name?: string | null;
  address?: string | null;
  note?: string | null;
}

export interface CorporateNumberDetectionInOwner {
  /** 検出された 13桁法人番号（dedup 済）。 */
  candidates: string[];
  /** どのフィールドで 1 件以上検出されたか。 */
  detectedIn: Array<"name" | "address" | "note">;
}

/**
 * Owner-like オブジェクトの name / address / note から法人番号候補を検出する。
 *
 * Phase A では検出結果を「UI 上の注意表示」「補正候補画面」に使う用途のみで、
 * 自動で Owner.name / address を書き換えることはしない。
 */
export function detectCorporateNumberInOwnerLike(
  owner: OwnerLikeForCorporateDetection,
): CorporateNumberDetectionInOwner {
  const detectedIn: Array<"name" | "address" | "note"> = [];
  const candidates = new Set<string>();

  const fields: Array<["name" | "address" | "note", string | null | undefined]> = [
    ["name", owner.name],
    ["address", owner.address],
    ["note", owner.note],
  ];

  for (const [field, value] of fields) {
    const hits = extractCorporateNumbersFromText(value);
    if (hits.length > 0) {
      detectedIn.push(field);
      for (const h of hits) candidates.add(h);
    }
  }

  return {
    candidates: Array.from(candidates),
    detectedIn,
  };
}

export interface CompanyRegistryNumberDetectionInOwner {
  /** 検出された 12桁会社法人等番号（dedup 済）。 */
  candidates: string[];
  /** どのフィールドで 1 件以上検出されたか。 */
  detectedIn: Array<"name" | "address" | "note">;
}

/**
 * Owner-like の name / address / note から会社法人等番号(12桁)候補を検出する。
 *
 * - ラベル付き(「会社法人等番号」「法人等番号」)のみ抽出する
 *   (extractCompanyRegistryNumbersFromText)。裸 12桁は誤検出回避で対象外。
 * - 13桁(法人番号)とは別物。detect 結果は UI 上の「候補転記/検索」用途のみで、
 *   自動で Owner.companyRegistryNumber を書き換えることはしない。
 */
export function detectCompanyRegistryNumberInOwnerLike(
  owner: OwnerLikeForCorporateDetection,
): CompanyRegistryNumberDetectionInOwner {
  const detectedIn: Array<"name" | "address" | "note"> = [];
  const candidates = new Set<string>();

  const fields: Array<["name" | "address" | "note", string | null | undefined]> = [
    ["name", owner.name],
    ["address", owner.address],
    ["note", owner.note],
  ];

  for (const [field, value] of fields) {
    const hits = extractCompanyRegistryNumbersFromText(value);
    if (hits.length > 0) {
      detectedIn.push(field);
      for (const h of hits) candidates.add(h);
    }
  }

  return {
    candidates: Array.from(candidates),
    detectedIn,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 会社法人等番号(12桁) ⇔ 法人番号(13桁) の変換・検証・分類。
//
// 別物として扱う:
//  - 12桁 = 会社法人等番号(不動産登記の番号)。
//  - 13桁 = 法人番号(国税庁)。先頭1桁はチェックデジット、残り12桁が会社法人等番号(基礎番号)。
//
// 国税庁チェックデジット算法(基礎番号=12桁):
//  - 基礎番号を右端から数える(右端=1桁目)。
//  - 奇数桁(1,3,5…) ×1、偶数桁(2,4,6…) ×2 の総和 s。
//  - r = s mod 9。 checkDigit = 9 - r (∴ 1..9。先頭に付与して13桁法人番号にする)。
//  例: 700110005901 → 8700110005901 / 326405515335 → 8326405515335。
//
// これらは既存の normalizeCorporateNumber(13桁) / normalizeCompanyRegistryNumber(12桁) を
// 置き換えない(検出/移送ロジックには干渉しない)。lookup 入口で「入力を13桁に解決する」用途。
// ───────────────────────────────────────────────────────────────────────────

/** classifyCorporateIdentifier の戻り値。 */
export type CorporateIdentifierKind =
  | "company_corporate_number_12"
  | "corporate_number_13"
  | "invalid";

/**
 * 任意入力を「半角数字のみ」に正規化する(全角数字→半角、ハイフン類・空白を除去)。
 * - null / undefined / 空 → null
 * - 除去後に数字以外を含む / 空になる → null
 * 桁数は判定しない(12/13桁の判定は classify 側)。
 */
export function normalizeCorporateIdentifier(
  input: string | null | undefined,
): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const digits = toHalfwidthDigitsOnly(trimmed);
  if (digits === "" || !/^\d+$/.test(digits)) return null;
  return digits;
}

/**
 * 12桁基礎番号からチェックデジット(1..9)を算出する。
 * 入力がちょうど12桁の半角数字でなければ null。
 */
function computeCorporateCheckDigit(base12: string): number | null {
  if (!/^\d{12}$/.test(base12)) return null;
  let sum = 0;
  for (let i = 0; i < COMPANY_REGISTRY_NUMBER_LENGTH; i++) {
    // base12 の右端を 1 桁目とする。i=0 が右端。
    const digit = base12.charCodeAt(COMPANY_REGISTRY_NUMBER_LENGTH - 1 - i) - 48;
    const positionFromRight = i + 1; // 1-indexed
    const weight = positionFromRight % 2 === 1 ? 1 : 2; // 奇数桁×1 / 偶数桁×2
    sum += digit * weight;
  }
  return 9 - (sum % 9); // r=s%9 ∈ 0..8 → 9-r ∈ 1..9
}

/**
 * 12桁会社法人等番号 → 13桁法人番号を算出する(チェックデジットを先頭に付与)。
 * - 入力を正規化(全角/ハイフン/空白吸収)後、ちょうど12桁数字でなければ null。
 * - 戻り値は normalizeCorporateNumber / lookup にそのまま渡せる 13桁文字列。
 */
export function calculateCorporateNumberFromCompanyNumber(
  companyNumber12: string | null | undefined,
): string | null {
  const normalized = normalizeCorporateIdentifier(companyNumber12);
  if (normalized == null || normalized.length !== COMPANY_REGISTRY_NUMBER_LENGTH) {
    return null;
  }
  const checkDigit = computeCorporateCheckDigit(normalized);
  if (checkDigit == null) return null;
  return `${checkDigit}${normalized}`;
}

/**
 * 13桁法人番号のチェックデジットを検証する。
 * - 正規化後ちょうど13桁数字 かつ 先頭桁が基礎番号(残り12桁)から算出した値に一致 → true
 * - それ以外(桁数違い・数字以外・チェックデジット不一致) → false
 */
export function isValidCorporateNumber13(
  corporateNumber13: string | null | undefined,
): boolean {
  const normalized = normalizeCorporateIdentifier(corporateNumber13);
  if (normalized == null || normalized.length !== CORPORATE_NUMBER_LENGTH) {
    return false;
  }
  const checkDigit = normalized.charCodeAt(0) - 48;
  const base12 = normalized.slice(1);
  const computed = computeCorporateCheckDigit(base12);
  return computed != null && computed === checkDigit;
}

/**
 * 入力を会社法人等番号(12桁) / 法人番号(13桁) / invalid に分類する。
 *  - 正規化後 12桁数字 → "company_corporate_number_12"
 *  - 正規化後 13桁数字 かつ チェックデジット妥当 → "corporate_number_13"
 *  - それ以外(11/14桁・13桁CD不正・数字以外・空) → "invalid"
 *
 * 12桁は会社法人等番号(自己検証桁を持たない)ため桁数で判定する。
 * 13桁はチェックデジットまで検証する(不正な13桁は invalid に倒す)。
 */
export function classifyCorporateIdentifier(
  input: string | null | undefined,
): CorporateIdentifierKind {
  const normalized = normalizeCorporateIdentifier(input);
  if (normalized == null) return "invalid";
  if (normalized.length === COMPANY_REGISTRY_NUMBER_LENGTH) {
    return "company_corporate_number_12";
  }
  if (
    normalized.length === CORPORATE_NUMBER_LENGTH &&
    isValidCorporateNumber13(normalized)
  ) {
    return "corporate_number_13";
  }
  return "invalid";
}

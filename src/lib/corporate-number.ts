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

const LABELED_CORPORATE_NUMBER_RE =
  /(?:法人番号|会社法人等番号|法人No\.?|法人ナンバー|Corporate Number|corporateNumber|corporate_number)[\s:：=]*([0-9０-９][0-9０-９\s\-‐‑‒–—―ー－−─]{11,30})/gi;

const BARE_CORPORATE_NUMBER_RE = /(?<![\d-])(\d{13})(?!\d)/g;

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

/**
 * 裸の全角数字 13桁にもマッチする正規表現。
 * BARE_CORPORATE_NUMBER_RE は半角 \d のみのため、全角数字のみの列は別途処理する。
 * 全角数字 [０-９] の連続 13桁（前後に半角数字・全角数字・ハイフンが連結しない）を対象とする。
 */
const BARE_FULLWIDTH_CORPORATE_NUMBER_RE = /(?<![0-9０-９\-])([０-９]{13})(?![0-9０-９\-])/g;

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

  // 1. ラベル付き(ラベル+区切り+番号)を除去
  let result = input.replace(LABELED_CORPORATE_NUMBER_RE, (full, num: string) => {
    const normalized = normalizeCorporateNumber(num);
    return normalized && targets.has(normalized) ? "" : full;
  });
  // 2. 裸 13桁(半角)を除去
  result = result.replace(BARE_CORPORATE_NUMBER_RE, (full, num: string) => {
    const normalized = normalizeCorporateNumber(num);
    return normalized && targets.has(normalized) ? "" : full;
  });
  // 3. 裸 13桁(全角)を除去
  result = result.replace(BARE_FULLWIDTH_CORPORATE_NUMBER_RE, (full, num: string) => {
    const normalized = normalizeCorporateNumber(num);
    return normalized && targets.has(normalized) ? "" : full;
  });
  return tidyAfterCorporateRemoval(result);
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

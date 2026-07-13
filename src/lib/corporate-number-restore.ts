// 割れた会社法人等番号の復元(純関数)。
//
// 背景(2026-07-13 本番調査): 外部exe由来の所有者Excelでは、登記PDFの所有者欄が
// 固定幅で折り返される影響で、法人所有者の「会社法人等番号(12桁)」が
//   パターン1: 住所末尾に「ラベル+前半断片」/ 氏名に「後半の数字だけ」
//     例) 住所 "…渋谷アクシュ２１Ｆ会社法人等番号０１１０－０１－０" + 氏名 "５９４４２"
//   パターン2: 氏名が「会社名+ラベル+尻切れ断片」
//     例) 氏名 "株式会社〇〇会社法人等番号０１２４－０１－０"
// の形に分断されて取り込まれる。本モジュールはこの分断を検出し、可能なら
// 12桁を復元して13桁法人番号を算出する(パターン1)。パターン2は会社名の救出のみ。
//
// 設計上の不変条件:
// - DB/IOなしの純関数(取込ガード・補正候補APIの両方から再利用する)
// - 完全な12桁(ラベル付き)は既存検出(extractCompanyRegistryNumbersFromText)の
//   守備範囲なので、ここでは扱わない(二重検出・二重反映を防ぐ)
// - 12桁⇔13桁の変換・正規化は corporate-number.ts を単一の source of truth とする

import {
  normalizeCorporateIdentifier,
  calculateCorporateNumberFromCompanyNumber,
} from "./corporate-number";

export type SplitCorporateType = "address_name_split" | "name_fragment";

export interface SplitCorporateDetection {
  type: SplitCorporateType;
  /** パターン1で復元できた12桁(会社法人等番号)。パターン2では null */
  companyRegistryNumber12: string | null;
  /** 12桁から算出した13桁法人番号(チェックデジット付与)。パターン2では null */
  corporateNumber13: string | null;
  /**
   * パターン2: 断片を除去した会社名。会社名部分が空なら null(自動修復不可)。
   * パターン1: 会社名は失われている(国税庁lookupで復元する)ため常に null。
   */
  cleanedName: string | null;
  /** パターン1: ラベル+断片を除去した住所。パターン2では null(住所は触らない) */
  cleanedAddress: string | null;
}

// ラベル: 「会社法人等番号」または「法人等番号」(12桁系の既存ラベルと同一集合)
const LABEL_SRC = "(?:会社法人等番号|法人等番号)";
// 断片: 数字で始まり、数字・ハイフン類・空白の連続(全角/半角)。
// ハイフン集合は corporate-number.ts の HYPHEN_LIKE_CHARS と同一。
const FRAGMENT_SRC = "[0-9０-９][0-9０-９\\s　\\-‐‑‒–—―ー－−─]*";

// パターン1: 住所の「末尾」がラベル+断片で終わる(途中折返しの前半)。
const ADDRESS_TAIL_RE = new RegExp(
  `${LABEL_SRC}[\\s　:：=]*(${FRAGMENT_SRC})$`,
);
// 氏名が数字(全角/半角)のみ(折返しの後半)。
const NAME_DIGITS_ONLY_RE = /^[0-9０-９]+$/;

// パターン2: 氏名 = 会社名(先頭・空でも可) + ラベル + 断片 で終わる。
const NAME_FRAGMENT_RE = new RegExp(
  `^(.*?)[\\s　]*${LABEL_SRC}[\\s　:：=]*(${FRAGMENT_SRC})$`,
);

/** 除去後の末尾に残る区切り・空白を整える(会社名/住所共通) */
function tidyTail(s: string): string {
  return s.replace(/[\s　、,・/／]+$/u, "").trim();
}

export interface OwnerLikeForRestore {
  name: string | null | undefined;
  address: string | null | undefined;
}

/**
 * 分断された会社法人等番号を検出する。
 * - パターン1(住所末尾断片+数字のみ氏名)が成立し、断片+氏名の数字が
 *   ちょうど12桁になる場合のみ復元する(11桁以下/13桁以上は別物として不採用)。
 * - 断片単独で12桁ちょうどの場合は既存のラベル付き12桁検出に委譲(ここでは null)。
 * - パターン1不成立時のみパターン2を判定する。
 */
export function detectSplitCorporateOwner(
  owner: OwnerLikeForRestore,
): SplitCorporateDetection | null {
  const name = owner.name ?? "";
  const address = owner.address ?? "";

  // --- パターン1: 住所末尾断片 + 数字のみ氏名 → 12桁復元 ---
  const addrMatch = address.match(ADDRESS_TAIL_RE);
  const trimmedName = name.trim();
  if (addrMatch && trimmedName !== "" && NAME_DIGITS_ONLY_RE.test(trimmedName)) {
    const addrDigits = normalizeCorporateIdentifier(addrMatch[1]);
    const nameDigits = normalizeCorporateIdentifier(trimmedName);
    if (
      addrDigits != null &&
      nameDigits != null &&
      addrDigits.length < 12 &&
      addrDigits.length + nameDigits.length === 12
    ) {
      const registry12 = addrDigits + nameDigits;
      const corporate13 =
        calculateCorporateNumberFromCompanyNumber(registry12);
      const cleanedAddress = tidyTail(
        address.slice(0, addrMatch.index ?? 0),
      );
      return {
        type: "address_name_split",
        companyRegistryNumber12: registry12,
        corporateNumber13: corporate13,
        cleanedName: null,
        cleanedAddress: cleanedAddress === "" ? null : cleanedAddress,
      };
    }
  }

  // --- パターン2: 氏名内の尻切れ断片 → 会社名の救出のみ ---
  const nameMatch = name.match(NAME_FRAGMENT_RE);
  if (nameMatch) {
    const fragDigits = normalizeCorporateIdentifier(nameMatch[2]);
    // 12桁ちょうど(完全)は既存検出に委譲。1〜11桁のみ「尻切れ断片」とみなす。
    if (fragDigits != null && fragDigits.length >= 1 && fragDigits.length <= 11) {
      const cleaned = tidyTail(nameMatch[1]);
      return {
        type: "name_fragment",
        companyRegistryNumber12: null,
        corporateNumber13: null,
        cleanedName: cleaned === "" ? null : cleaned,
        cleanedAddress: null,
      };
    }
  }

  return null;
}

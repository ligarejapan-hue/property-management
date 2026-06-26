// 開発・テスト用の法人番号 lookup mock。
// NEXT_PUBLIC_USE_MOCK=true のときに使う。DB 更新は当然なし。
//
// 既定ケース(いずれもチェックデジット妥当な13桁。owner-scoped route が CD 検証するため):
//   - 8700110005901 (CD妥当な任意13桁) → found
//   - 9999999999999 → not found
//   - 9888888888888 → closed

import type {
  CorporateLookupProvider,
  CorporateLookupResult,
} from "./types";

const SOURCE_ID = "mock-corporate-lookup";

export class MockCorporateLookupProvider implements CorporateLookupProvider {
  readonly name = SOURCE_ID;

  async lookup(corporateNumber13: string): Promise<CorporateLookupResult> {
    const fetchedAt = new Date().toISOString();

    if (corporateNumber13 === "9999999999999") {
      return {
        found: false,
        isClosed: false,
        closeDate: null,
        closeCause: null,
        record: null,
        fetchedAt,
        source: SOURCE_ID,
      };
    }

    if (corporateNumber13 === "9888888888888") {
      return {
        found: true,
        isClosed: true,
        closeDate: "2024-12-31",
        closeCause: "01",
        record: {
          corporateNumber: corporateNumber13,
          name: "廃止モック株式会社",
          furigana: "ハイシモックカブシキガイシャ",
          address: "東京都港区六本木1-1-1",
          prefectureName: "東京都",
          cityName: "港区",
          streetNumber: "六本木1-1-1",
          postCode: "1060032",
          updateDate: "2024-12-31",
        },
        fetchedAt,
        source: SOURCE_ID,
      };
    }

    // 既定 found（1234567890123 を含む任意の13桁）
    return {
      found: true,
      isClosed: false,
      closeDate: null,
      closeCause: null,
      record: {
        corporateNumber: corporateNumber13,
        name: "モック株式会社",
        furigana: "モックカブシキガイシャ",
        address: "東京都千代田区丸の内1-1-1",
        prefectureName: "東京都",
        cityName: "千代田区",
        streetNumber: "丸の内1-1-1",
        postCode: "1000005",
        updateDate: "2025-04-01",
      },
      fetchedAt,
      source: SOURCE_ID,
    };
  }
}

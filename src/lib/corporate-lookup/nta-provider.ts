// 国税庁 法人番号 Web-API provider (Phase B preview)。
//
// 仕様: https://www.houjin-bangou.nta.go.jp/webapi/index.html
//   GET {CORPORATE_NUMBER_API_URL}?id={appId}&number={13桁}&type=12&history=0
//   - type=12 → UTF-8 XML（JSON ではない）
//   - history=0 → 最新のみ
//
// 取得項目: <corporation> 配下の name / furigana / prefectureName / cityName /
// streetNumber / postCode / closeDate / closeCause / updateDate。
// raw XML 全文は呼び出し側に返さず、保存もしない。

import {
  CorporateLookupError,
  type CorporateLookupProvider,
  type CorporateLookupRecord,
  type CorporateLookupResult,
} from "./types";
import { extractCorporationBlocks, extractTagText } from "./xml-extract";

const SOURCE_ID = "nta-houjin-bangou-v4";
const DEFAULT_URL = "https://api.houjin-bangou.nta.go.jp/4/num";
const DEFAULT_TIMEOUT_MS = 8000;

function joinAddress(
  prefecture: string | null,
  city: string | null,
  street: string | null,
): string {
  return [prefecture, city, street].filter((v): v is string => !!v).join("");
}

/**
 * <corporation> 1 ブロックを CorporateLookupRecord にマップする。
 * name が欠落しているデータは「不完全」とみなして null を返す。
 */
function parseCorporationBlock(
  block: string,
  fallbackNumber: string,
): { record: CorporateLookupRecord; closeDate: string | null; closeCause: string | null } | null {
  const name = extractTagText(block, "name");
  if (!name) return null;

  const corporateNumber = extractTagText(block, "corporateNumber") ?? fallbackNumber;
  const furigana = extractTagText(block, "furigana");
  const prefectureName = extractTagText(block, "prefectureName");
  const cityName = extractTagText(block, "cityName");
  const streetNumber = extractTagText(block, "streetNumber");
  const postCodeRaw = extractTagText(block, "postCode");
  const postCode = postCodeRaw && /^\d{7}$/.test(postCodeRaw) ? postCodeRaw : null;
  const updateDate = extractTagText(block, "updateDate");
  const closeDate = extractTagText(block, "closeDate");
  const closeCause = extractTagText(block, "closeCause");

  const record: CorporateLookupRecord = {
    corporateNumber,
    name,
    furigana,
    address: joinAddress(prefectureName, cityName, streetNumber),
    prefectureName,
    cityName,
    streetNumber,
    postCode,
    updateDate,
  };
  return { record, closeDate, closeCause };
}

export interface NtaProviderConfig {
  appId: string;
  url?: string;
  timeoutMs?: number;
  /** fetch 注入（テスト用） */
  fetchImpl?: typeof fetch;
}

export class NtaProvider implements CorporateLookupProvider {
  readonly name = SOURCE_ID;
  private readonly appId: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: NtaProviderConfig) {
    this.appId = config.appId;
    this.url = config.url ?? DEFAULT_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async lookup(corporateNumber13: string): Promise<CorporateLookupResult> {
    const params = new URLSearchParams({
      id: this.appId,
      number: corporateNumber13,
      type: "12",
      history: "0",
    });
    const requestUrl = `${this.url}?${params.toString()}`;

    let res: Response;
    try {
      res = await this.fetchImpl(requestUrl, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: "application/xml,text/xml,*/*" },
      });
    } catch (err) {
      // タイムアウト / DNS / connection refused
      const isAbort =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new CorporateLookupError(
        isAbort ? "TIMEOUT" : "NETWORK",
        isAbort ? "国税庁APIがタイムアウトしました" : "国税庁APIへの通信に失敗しました",
        null,
      );
    }

    if (res.status === 429) {
      throw new CorporateLookupError("RATE_LIMITED", "国税庁APIのレート制限に達しました", 429);
    }
    if (res.status >= 500) {
      throw new CorporateLookupError(
        "UPSTREAM_5XX",
        "国税庁APIが一時的に応答しません",
        res.status,
      );
    }
    if (!res.ok) {
      throw new CorporateLookupError(
        "UPSTREAM_4XX",
        "国税庁API へのリクエストが拒否されました",
        res.status,
      );
    }

    let xml: string;
    try {
      xml = await res.text();
    } catch {
      throw new CorporateLookupError("PARSE_ERROR", "レスポンス本文の読み取りに失敗しました");
    }

    const fetchedAt = new Date().toISOString();

    const blocks = extractCorporationBlocks(xml);
    if (blocks.length === 0) {
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

    // 防御的: 複数件返ってきた場合は最初の corporation を採用する（history=0 で通常1件）。
    const parsed = parseCorporationBlock(blocks[0], corporateNumber13);
    if (!parsed) {
      throw new CorporateLookupError("PARSE_ERROR", "国税庁APIのレスポンス形式が不正です");
    }

    return {
      found: true,
      isClosed: parsed.closeDate !== null,
      closeDate: parsed.closeDate,
      closeCause: parsed.closeCause,
      record: parsed.record,
      fetchedAt,
      source: SOURCE_ID,
    };
  }
}

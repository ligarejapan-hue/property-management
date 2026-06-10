/**
 * 日本郵便 郵便番号・デジタルアドレス API（ent-api.biz.da.pf.japanpost.jp 等）adapter。
 *
 * - 認証: client_credentials で token を取得し、検索リクエストに Bearer で付与する。
 *   secret（APIキー）は token 取得 body にのみ使い、検索リクエストや候補・例外に出さない。
 * - エンドポイントの base URL は env（ADDRESS_LOOKUP_BASE_URL）で差し替える。
 *   組織/サービス配下の systems URL を指定する想定。
 * - raw response は返さず {@link AddressLookupCandidate} へ整形する。
 * - 失敗時は {@link AddressLookupError}（分類コードのみの安全な例外）を throw する。
 *
 * 注: 外部 I/O を伴うため server-side（API route）からのみ利用する。client へ import しない。
 */

import { normalizePostalCode } from "./normalize";
import {
  AddressLookupError,
  type AddressLookupCandidate,
  type AddressLookupProvider,
  type AddressLookupErrorCode,
} from "./types";

export interface JapanPostProviderOptions {
  clientId: string;
  secretKey: string;
  baseUrl: string;
  /** テスト用に fetch を注入する（既定: グローバル fetch）。 */
  fetchFn?: typeof fetch;
  /** リクエスト timeout（ミリ秒・既定 8000）。 */
  timeoutMs?: number;
}

interface RawAddress {
  zip_code?: unknown;
  pref_name?: unknown;
  city_name?: unknown;
  town_name?: unknown;
}

export class JapanPostAddressProvider implements AddressLookupProvider {
  readonly name = "japanpost";

  private readonly clientId: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: JapanPostProviderOptions) {
    this.clientId = opts.clientId;
    this.secretKey = opts.secretKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async lookupByPostalCode(postalCode7: string): Promise<AddressLookupCandidate[]> {
    return this.search(postalCode7);
  }

  async searchByAddress(address: string): Promise<AddressLookupCandidate[]> {
    return this.search(address);
  }

  // ---- internal ----

  private async search(term: string): Promise<AddressLookupCandidate[]> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/api/v1/searchcode/${encodeURIComponent(term)}`;
    const res = await this.doFetch(
      url,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      "search",
    );
    if (!res.ok) throw this.classify(res.status, "search");
    const data = await this.parseJson(res, "search");
    return this.mapAddresses(data);
  }

  private async getToken(): Promise<string> {
    const url = `${this.baseUrl}/api/v1/j/token`;
    const res = await this.doFetch(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.clientId,
          secret_key: this.secretKey,
        }),
      },
      "token",
    );
    if (!res.ok) throw this.classify(res.status, "token");
    const data = (await this.parseJson(res, "token")) as {
      token?: unknown;
      access_token?: unknown;
    };
    const token =
      typeof data.token === "string"
        ? data.token
        : typeof data.access_token === "string"
          ? data.access_token
          : null;
    if (!token) {
      throw new AddressLookupError("AUTH_FAILED", "address lookup token missing");
    }
    return token;
  }

  private async doFetch(
    url: string,
    init: RequestInit,
    phase: string,
  ): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string } | undefined)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AddressLookupError("TIMEOUT", `address lookup timeout (${phase})`);
      }
      throw new AddressLookupError("NETWORK", `address lookup network error (${phase})`);
    }
  }

  private async parseJson(res: Response, phase: string): Promise<unknown> {
    const raw = await res.text();
    try {
      return JSON.parse(raw);
    } catch {
      // raw 本文は message に含めない（PII/secret 混入を防ぐ）。
      throw new AddressLookupError("PARSE_ERROR", `address lookup parse error (${phase})`);
    }
  }

  private classify(status: number, phase: string): AddressLookupError {
    let code: AddressLookupErrorCode;
    if (status === 401 || status === 403) code = "AUTH_FAILED";
    else if (status === 429) code = "RATE_LIMITED";
    else if (status >= 500) code = "UPSTREAM_5XX";
    else code = "UPSTREAM_4XX";
    // message には status と phase のみ（外部 raw 本文・secret は含めない）。
    return new AddressLookupError(code, `address lookup upstream error (${phase})`, status);
  }

  private mapAddresses(data: unknown): AddressLookupCandidate[] {
    const list =
      data && typeof data === "object" && Array.isArray((data as { addresses?: unknown }).addresses)
        ? ((data as { addresses: RawAddress[] }).addresses)
        : [];
    return list.map((a) => {
      const pref = typeof a.pref_name === "string" ? a.pref_name : undefined;
      const city = typeof a.city_name === "string" ? a.city_name : undefined;
      const town = typeof a.town_name === "string" ? a.town_name : undefined;
      const zipRaw = typeof a.zip_code === "string" ? a.zip_code : undefined;
      const zip = zipRaw ? normalizePostalCode(zipRaw) : undefined;
      const candidate: AddressLookupCandidate = {
        addressLine: [pref, city, town].filter(Boolean).join(""),
        source: this.name,
      };
      if (zip) candidate.postalCode = zip;
      if (pref) candidate.prefecture = pref;
      if (city) candidate.city = city;
      if (town) candidate.town = town;
      return candidate;
    });
  }
}

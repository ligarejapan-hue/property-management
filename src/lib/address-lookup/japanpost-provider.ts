/**
 * 日本郵便 郵便番号・デジタルアドレス API（ent-api.biz.da.pf.japanpost.jp 等）adapter。
 *
 * - 認証: client_credentials で token を取得し、検索リクエストに Bearer で付与する。
 *   secret（APIキー）は token 取得 body にのみ使い、検索リクエストや候補・例外に出さない。
 * - token 取得には登録済み送信元 IP を `x-forwarded-for` で送る（日本郵便の IP ベース認可）。
 *   IP は inbound request の XFF ではなく、サーバの登録 IP を env から渡す（sourceIp）。
 * - 検索エンドポイントは用途で分ける（混線防止）:
 *     郵便番号/デジタルアドレスコード → GET  /api/v1/searchcode/{code}
 *     住所（フリーワード）            → POST /api/v1/addresszip
 * - base URL は env（ADDRESS_LOOKUP_BASE_URL）で差し替える（組織/サービス配下 systems）。
 * - raw response は返さず {@link AddressLookupCandidate} へ整形する。
 * - 失敗時は {@link AddressLookupError}（分類コードのみの安全な例外）を throw。
 *   message には secret / client_id / source IP / 外部 raw 本文を含めない。
 *
 * 注: 外部 I/O を伴うため server-side（API route）からのみ利用する。client へ import しない。
 */

import { normalizePostalCode, isValidPostalCode } from "./normalize";
import {
  AddressLookupError,
  type AddressLookupCandidate,
  type AddressLookupProvider,
  type AddressLookupErrorCode,
} from "./types";

export interface JapanPostProviderOptions {
  clientId: string;
  secretKey: string;
  /** 登録済み送信元グローバル IP（x-forwarded-for で送る）。 */
  sourceIp: string;
  baseUrl: string;
  /** テスト用に fetch を注入する（既定: グローバル fetch）。 */
  fetchFn?: typeof fetch;
  /** リクエスト timeout（ミリ秒・既定 8000）。 */
  timeoutMs?: number;
}

interface RawAddress {
  zip_code?: unknown; // string も number も来る（API/項目により異なる）
  pref_name?: unknown;
  city_name?: unknown;
  town_name?: unknown;
}

export class JapanPostAddressProvider implements AddressLookupProvider {
  readonly name = "japanpost";

  private readonly clientId: string;
  private readonly secretKey: string;
  private readonly sourceIp: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: JapanPostProviderOptions) {
    this.clientId = opts.clientId;
    this.secretKey = opts.secretKey;
    this.sourceIp = opts.sourceIp;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /** 郵便番号/デジタルアドレスコード → searchcode（GET）。 */
  async lookupByPostalCode(postalCode7: string): Promise<AddressLookupCandidate[]> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/api/v1/searchcode/${encodeURIComponent(postalCode7)}`;
    const res = await this.doFetch(
      url,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      "searchcode",
    );
    if (!res.ok) throw this.classify(res.status, "searchcode");
    return this.mapAddresses(await this.parseJson(res, "searchcode"));
  }

  /** 住所（フリーワード）→ addresszip（POST）。code 検索とは別経路。 */
  async searchByAddress(address: string): Promise<AddressLookupCandidate[]> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/api/v1/addresszip`;
    const res = await this.doFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        // 日本郵便 addresszip のフリーワード住所検索フィールド。
        body: JSON.stringify({ freeword: address }),
      },
      "addresszip",
    );
    if (!res.ok) throw this.classify(res.status, "addresszip");
    return this.mapAddresses(await this.parseJson(res, "addresszip"));
  }

  // ---- internal ----

  private async getToken(): Promise<string> {
    const url = `${this.baseUrl}/api/v1/j/token`;
    const res = await this.doFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 登録済み送信元 IP。inbound の XFF ではなく env 由来の自サーバ IP。
          "x-forwarded-for": this.sourceIp,
        },
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
    // message には status と phase のみ（外部 raw 本文・secret・source IP は含めない）。
    return new AddressLookupError(code, `address lookup upstream error (${phase})`, status);
  }

  /**
   * zip_code（string または number）を 7 桁の郵便番号文字列へ。
   * number は先頭 0 落ち対策で padStart(7, "0") してから正規化する。
   * 7 桁にできなければ undefined（candidate.postalCode に入れない）。
   */
  private toPostalCode(zipRaw: unknown): string | undefined {
    let s: string | undefined;
    if (typeof zipRaw === "number" && Number.isFinite(zipRaw)) {
      s = String(zipRaw).padStart(7, "0");
    } else if (typeof zipRaw === "string") {
      s = zipRaw;
    }
    if (s === undefined) return undefined;
    const normalized = normalizePostalCode(s);
    return isValidPostalCode(normalized) ? normalized : undefined;
  }

  private extractAddresses(data: unknown): RawAddress[] {
    if (data && typeof data === "object") {
      const addresses = (data as { addresses?: unknown }).addresses;
      if (Array.isArray(addresses)) {
        // 日本郵便 addresszip は候補を addresses 配下に「配列の配列」(グループ)で返す。
        // searchcode は flat。1段平坦化で両形を統一し、オブジェクト行のみ採用する
        // （flat 形には無改変＝searchcode の挙動は不変）。
        return (addresses as unknown[])
          .flat()
          .filter(
            (a): a is RawAddress =>
              a !== null && typeof a === "object" && !Array.isArray(a),
          );
      }
    }
    return [];
  }

  private mapAddresses(data: unknown): AddressLookupCandidate[] {
    return this.extractAddresses(data).map((a) => {
      const pref = typeof a.pref_name === "string" ? a.pref_name : undefined;
      const city = typeof a.city_name === "string" ? a.city_name : undefined;
      const town = typeof a.town_name === "string" ? a.town_name : undefined;
      const postalCode = this.toPostalCode(a.zip_code);
      const candidate: AddressLookupCandidate = {
        addressLine: [pref, city, town].filter(Boolean).join(""),
        source: this.name,
      };
      if (postalCode) candidate.postalCode = postalCode;
      if (pref) candidate.prefecture = pref;
      if (city) candidate.city = city;
      if (town) candidate.town = town;
      return candidate;
    });
  }
}

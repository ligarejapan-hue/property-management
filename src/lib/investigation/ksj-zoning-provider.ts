/**
 * KSJ (国土数値情報) Zoning Provider
 *
 * 国土数値情報の用途地域データ (A29) から以下を取得する:
 *   - zoningDistrict      : 用途地域
 *   - buildingCoverageRatio: 建蔽率 (%)
 *   - floorAreaRatio       : 容積率 (%)
 *   - heightDistrict       : 高度地区
 *   - firePreventionZone   : 防火地域・準防火地域
 *
 * 座標未設定の物件は 国土地理院 ジオコーディングAPI (無料・無認証) で補完する。
 *
 * --- 必要な環境変数 ---
 *
 *   KSJ_API_URL=<GeoServer または WFS 互換エンドポイントのベース URL>
 *
 *   例 (GeoServer):
 *     KSJ_API_URL=http://localhost:8080/geoserver/ksj/ows
 *
 *   例 (カスタム REST):
 *     KSJ_API_URL=https://your-spatial-api.example.com/ksj
 *
 * --- API レスポンス期待形式 ---
 *
 *   GeoJSON FeatureCollection を返すこと。
 *   各 Feature の properties には KSJ A29 の属性名を使用する:
 *     A29_002: 用途地域コード (string | number)
 *     A29_003: 建蔽率 (number, 単位: %)
 *     A29_004: 容積率 (number, 単位: %)
 *     A29_005: 高度地区 (string)
 *     A29_007: 防火地域コード (string | number)
 *
 *   独自 REST サーバーの場合は getZoningByPoint() のレスポンスパースを調整すること。
 *
 * --- 登録方法 ---
 *
 *   src/lib/investigation/index.ts の getProviders() 内のコメントを外すか、
 *   以下を追加する:
 *     if (process.env.KSJ_API_URL) providers.push(new KsjZoningProvider());
 */

import type {
  InvestigationProvider,
  InvestigationQuery,
  ProviderResponse,
  InvestigationResult,
} from "./types";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 国土地理院 住所検索 API (無料・API キー不要) */
const GSI_GEOCODE_URL =
  "https://msearch.gsi.go.jp/address-search/AddressSearch";

/** KSJ A29 用途地域コード → 日本語ラベル */
const USE_DISTRICT_LABELS: Record<string, string> = {
  "1": "第一種低層住居専用地域",
  "2": "第二種低層住居専用地域",
  "3": "第一種中高層住居専用地域",
  "4": "第二種中高層住居専用地域",
  "5": "第一種住居地域",
  "6": "第二種住居地域",
  "7": "準住居地域",
  "8": "田園住居地域",
  "9": "近隣商業地域",
  "10": "商業地域",
  "11": "準工業地域",
  "12": "工業地域",
  "13": "工業専用地域",
};

/** KSJ A29_007 防火地域コード → 日本語ラベル */
const FIRE_ZONE_LABELS: Record<string, string> = {
  "1": "防火地域",
  "2": "準防火地域",
  "3": "法22条区域",
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class KsjZoningProvider implements InvestigationProvider {
  readonly name = "ksj-zoning";
  readonly description =
    "国土数値情報 A29 (用途地域) から用途地域・建蔽率・容積率・高度地区・防火地域を取得";
  readonly fields: (keyof InvestigationResult)[] = [
    "zoningDistrict",
    "buildingCoverageRatio",
    "floorAreaRatio",
    "heightDistrict",
    "firePreventionZone",
  ];

  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = (process.env.KSJ_API_URL ?? "").replace(/\/$/, "");
    if (!this.baseUrl) {
      throw new Error("KSJ_API_URL が設定されていません");
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async fetch(query: InvestigationQuery): Promise<ProviderResponse> {
    // 1. 座標を確保（物件DB の GPS 値を優先。なければ住所から変換）
    let lat = query.gpsLat ?? null;
    let lng = query.gpsLng ?? null;

    if (lat === null || lng === null) {
      const coords = await this.geocode(query.address);
      if (!coords) {
        throw new Error(
          `住所のジオコーディングに失敗しました: "${query.address}"`,
        );
      }
      lat = coords.lat;
      lng = coords.lng;
    }

    // 2. KSJ API で用途地域データを取得
    const geoJson = await this.fetchZoningGeoJson(lat, lng);

    // 3. レスポンスをパース
    const data = this.parseZoningFeature(geoJson);

    return {
      source: "国土数値情報 A29 (用途地域)",
      data,
      meta: {
        lat,
        lng,
        ksjIdentifier: "A29",
        featureCount: geoJson?.features?.length ?? 0,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      // WFS GetCapabilities で疎通確認
      const url = this.buildWfsUrl({ request: "GetCapabilities" });
      const res = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * 国土地理院 住所検索 API で住所 → 座標を取得する。
   * API キー不要・無料。
   * 失敗時は null を返す（例外を投げない）。
   */
  private async geocode(
    address: string,
  ): Promise<{ lat: number; lng: number } | null> {
    try {
      const url = `${GSI_GEOCODE_URL}?q=${encodeURIComponent(address)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;

      const results: GsiGeocodingFeature[] = await res.json();
      if (!Array.isArray(results) || results.length === 0) return null;

      // GeoJSON coordinates は [lng, lat] の順
      const [lng, lat] = results[0].geometry.coordinates;
      return { lat, lng };
    } catch {
      return null;
    }
  }

  /**
   * KSJ API (WFS GetFeature) を呼び出して GeoJSON を取得する。
   *
   * 以下の2種類のバックエンドに対応:
   *   1. GeoServer (OGC WFS 1.0.0 + CQL_FILTER)
   *   2. カスタム REST   → baseUrl/a29?lat=&lng= 形式のフォールバック
   */
  private async fetchZoningGeoJson(
    lat: number,
    lng: number,
  ): Promise<GeoJsonFeatureCollection> {
    // まず WFS スタイルを試みる
    const wfsUrl = this.buildWfsUrl({
      request: "GetFeature",
      typeName: "ksj:A29",
      outputFormat: "application/json",
      // GeoServer CQL_FILTER: 座標点を含むポリゴンを検索
      CQL_FILTER: `CONTAINS(the_geom,POINT(${lng} ${lat}))`,
      maxFeatures: "1",
    });

    const res = await fetch(wfsUrl, { signal: AbortSignal.timeout(15_000) });

    if (!res.ok) {
      // WFS が失敗した場合はカスタム REST フォールバックを試みる
      return this.fetchZoningCustomRest(lat, lng);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      // XML (WFS エラーレスポンスなど) の場合はフォールバック
      return this.fetchZoningCustomRest(lat, lng);
    }

    return res.json() as Promise<GeoJsonFeatureCollection>;
  }

  /**
   * カスタム REST エンドポイント用フォールバック。
   *
   * 期待するエンドポイント:
   *   GET {KSJ_API_URL}/a29?lat={lat}&lng={lng}
   *
   * 独自実装の場合はここを修正すること。
   */
  private async fetchZoningCustomRest(
    lat: number,
    lng: number,
  ): Promise<GeoJsonFeatureCollection> {
    const url = new URL(`${this.baseUrl}/a29`);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lng", String(lng));

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(
        `KSJ API エラー: ${res.status} ${res.statusText} (${url})`,
      );
    }

    return res.json() as Promise<GeoJsonFeatureCollection>;
  }

  /**
   * GeoJSON から InvestigationResult へ変換する。
   * KSJ A29 の属性コード (A29_002 等) を使用する。
   */
  private parseZoningFeature(geoJson: GeoJsonFeatureCollection): InvestigationResult {
    const props = geoJson?.features?.[0]?.properties;
    if (!props) return {};

    const data: InvestigationResult = {};

    // 用途地域 (A29_002)
    const districtCode = String(props["A29_002"] ?? "");
    if (districtCode) {
      data.zoningDistrict =
        USE_DISTRICT_LABELS[districtCode] ?? `用途地域コード:${districtCode}`;
    }

    // 建蔽率 (A29_003, 単位: %)
    const bcr = Number(props["A29_003"]);
    if (!isNaN(bcr) && bcr > 0) {
      data.buildingCoverageRatio = bcr;
    }

    // 容積率 (A29_004, 単位: %)
    const far = Number(props["A29_004"]);
    if (!isNaN(far) && far > 0) {
      data.floorAreaRatio = far;
    }

    // 高度地区 (A29_005)
    const heightDistrict = props["A29_005"];
    if (heightDistrict !== undefined && heightDistrict !== null && heightDistrict !== "") {
      data.heightDistrict = String(heightDistrict);
    }

    // 防火地域 (A29_007)
    const fireZoneCode = String(props["A29_007"] ?? "");
    if (fireZoneCode && fireZoneCode !== "0") {
      data.firePreventionZone =
        FIRE_ZONE_LABELS[fireZoneCode] ?? `防火地域コード:${fireZoneCode}`;
    }

    return data;
  }

  /** WFS クエリ URL を組み立てるユーティリティ */
  private buildWfsUrl(params: Record<string, string>): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set("service", "WFS");
    url.searchParams.set("version", "1.0.0");
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }
}

// ---------------------------------------------------------------------------
// 型定義 (ローカル)
// ---------------------------------------------------------------------------

interface GsiGeocodingFeature {
  geometry: { coordinates: [number, number]; type: "Point" };
  properties: { addressCode: string; title: string };
  type: "Feature";
}

interface GeoJsonFeatureCollection {
  type: string;
  features?: Array<{
    type: string;
    properties: Record<string, unknown>;
    geometry?: unknown;
  }>;
}

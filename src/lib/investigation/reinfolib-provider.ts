/**
 * ReinfilibProvider
 *
 * 国土交通省 不動産情報ライブラリ API を使って、住所から
 * 都市計画情報（用途地域・建蔽率・容積率・防火地域・高度地区）を取得する。
 *
 * ── 必要な環境変数 ──────────────────────────────────────────────────────────
 *   REINFOLIB_API_KEY=<サブスクリプションキー>
 *   ヘッダー Ocp-Apim-Subscription-Key に自動セットされる。
 *
 * ── 利用 API ───────────────────────────────────────────────────────────────
 *   1. 国土地理院 住所検索 API (無料・認証不要)
 *      https://msearch.gsi.go.jp/address-search/AddressSearch?q=...
 *      → 住所を緯度経度に変換する
 *
 *   2. 不動産情報ライブラリ 都市計画情報 (XPT001)
 *      GET https://www.reinfolib.mlit.go.jp/ex-api/external/XPT001
 *        ?response_format=geojson&epsg=4326&z={z}&x={x}&y={y}
 *      → 用途地域・建蔽率・容積率・高度地区・防火地域を取得する
 *
 * ── レスポンス属性名について ──────────────────────────────────────────────
 *   REINFOLIB は KSJ A29 の属性コードをそのまま使う。
 *   万一 API のバージョンアップで属性名が変わった場合は
 *   parseZoningFeature() 内の FIELD_CANDIDATES を修正すること。
 *
 * ── 出典表示 ──────────────────────────────────────────────────────────────
 *   source に "国土交通省 不動産情報ライブラリ" を返す。
 *   UI 側で「参考情報」として表示すること（investigation-tab.tsx 参照）。
 */

import type {
  InvestigationProvider,
  InvestigationQuery,
  InvestigationResult,
  ProviderResponse,
} from "./types";

// ── 定数 ────────────────────────────────────────────────────────────────────

const REINFOLIB_BASE = "https://www.reinfolib.mlit.go.jp/ex-api/external";
const GSI_GEOCODE_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch";

/** XPT001 クエリに使うズームレベル（16 が用途地域タイル解像度として適切） */
const ZOOM = 16;

/** 用途地域コード → 日本語ラベル（KSJ A29_002 準拠） */
const ZONE_LABELS: Record<string, string> = {
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

/** 防火地域コード → 日本語ラベル（KSJ A29_007 準拠） */
const FIRE_ZONE_LABELS: Record<string, string> = {
  "1": "防火地域",
  "2": "準防火地域",
  "3": "法22条区域",
};

// ── タイル変換 ───────────────────────────────────────────────────────────────

function lngLatToTile(
  lat: number,
  lng: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

// ── 型定義 ──────────────────────────────────────────────────────────────────

interface GsiFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { addressCode: string; title: string };
}

interface GeoJsonFC {
  type: string;
  features?: Array<{
    type: string;
    properties: Record<string, unknown>;
    geometry?: unknown;
  }>;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class ReinfilibProvider implements InvestigationProvider {
  readonly name = "reinfolib";
  readonly description =
    "国土交通省 不動産情報ライブラリ API — 用途地域・建蔽率・容積率・防火地域・高度地区";
  readonly fields: (keyof InvestigationResult)[] = [
    "zoningDistrict",
    "buildingCoverageRatio",
    "floorAreaRatio",
    "firePreventionZone",
    "heightDistrict",
  ];

  private readonly apiKey: string;

  constructor() {
    const key = process.env.REINFOLIB_API_KEY;
    if (!key) {
      throw new Error(
        "REINFOLIB_API_KEY が設定されていません。" +
          "/etc/property-management/app.env を確認してください。",
      );
    }
    this.apiKey = key;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  async fetch(query: InvestigationQuery): Promise<ProviderResponse> {
    // 1. 住所 → 緯度経度（物件DBにGPS値があればそちらを優先）
    const geo = await this.geocode(query.address);
    const lat = query.gpsLat ?? geo?.lat ?? null;
    const lng = query.gpsLng ?? geo?.lng ?? null;

    if (lat === null || lng === null) {
      throw new Error(
        `住所のジオコーディングに失敗しました: "${query.address}"`,
      );
    }

    // 2. REINFOLIB 都市計画情報 (XPT001)
    const zoningData = await this.fetchZoning(lat, lng);

    return {
      source: "国土交通省 不動産情報ライブラリ",
      data: zoningData,
      meta: {
        normalizedAddress: geo?.title ?? null,
        geocodedLat: lat,
        geocodedLng: lng,
        geocodeSource: query.gpsLat != null ? "property-db" : "gsi",
        zoom: ZOOM,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      // キー疎通確認: タイル (0,0,0) は常に存在する
      const res = await fetch(
        `${REINFOLIB_BASE}/XPT001?response_format=geojson&epsg=4326&z=0&x=0&y=0`,
        {
          method: "HEAD",
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(5_000),
        },
      );
      return res.status < 500;
    } catch {
      return false;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    return { "Ocp-Apim-Subscription-Key": this.apiKey };
  }

  /**
   * 国土地理院 住所検索 API でジオコーディング（無料・認証不要）。
   * 失敗時は null を返す（プロバイダ内で上位エラーに変換する）。
   */
  private async geocode(
    address: string,
  ): Promise<{ lat: number; lng: number; title: string } | null> {
    try {
      const url = `${GSI_GEOCODE_URL}?q=${encodeURIComponent(address)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;

      const results: GsiFeature[] = await res.json();
      if (!Array.isArray(results) || results.length === 0) return null;

      // GeoJSON coordinates は [lng, lat]
      const [lng, lat] = results[0].geometry.coordinates;
      return { lat, lng, title: results[0].properties.title };
    } catch {
      return null;
    }
  }

  /**
   * REINFOLIB XPT001 (都市計画情報) を呼び出す。
   * タイル座標へ変換して GeoJSON を取得し、含まれる用途地域フィーチャをパースする。
   */
  private async fetchZoning(
    lat: number,
    lng: number,
  ): Promise<InvestigationResult> {
    const { x, y } = lngLatToTile(lat, lng, ZOOM);
    const url =
      `${REINFOLIB_BASE}/XPT001` +
      `?response_format=geojson&epsg=4326&z=${ZOOM}&x=${x}&y=${y}`;

    const res = await fetch(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(
        `不動産情報ライブラリ API エラー: HTTP ${res.status} ${res.statusText}`,
      );
    }

    const json: GeoJsonFC = await res.json();
    return this.parseZoningFeature(json);
  }

  /**
   * GeoJSON フィーチャから InvestigationResult へ変換する。
   *
   * REINFOLIB は KSJ A29 の属性コードを使用する。
   * 各属性に複数の候補名を列挙し、最初にヒットした値を採用する。
   */
  private parseZoningFeature(fc: GeoJsonFC): InvestigationResult {
    const props = fc?.features?.[0]?.properties;
    if (!props) return {};

    const result: InvestigationResult = {};

    // 用途地域コード (A29_002)
    const zoneCode = this.pick(props, ["A29_002", "youto_chiiki_cd", "youto"]);
    if (zoneCode !== null) {
      const code = String(zoneCode);
      result.zoningDistrict =
        ZONE_LABELS[code] ?? `用途地域コード: ${code}`;
    }

    // 建蔽率 % (A29_003)
    const bcr = this.pickNumber(props, ["A29_003", "kenpei_ritsu", "bcr"]);
    if (bcr !== null && bcr > 0) result.buildingCoverageRatio = bcr;

    // 容積率 % (A29_004)
    const far = this.pickNumber(props, ["A29_004", "yoseki_ritsu", "far"]);
    if (far !== null && far > 0) result.floorAreaRatio = far;

    // 高度地区 (A29_005)
    const hd = this.pick(props, ["A29_005", "kodo_chiku", "height_district"]);
    if (hd !== null && hd !== "") result.heightDistrict = String(hd);

    // 防火地域コード (A29_007)
    const fireCode = this.pick(props, ["A29_007", "bouka_chiiki_cd", "bouka"]);
    if (fireCode !== null) {
      const code = String(fireCode);
      if (code !== "0" && code !== "") {
        result.firePreventionZone =
          FIRE_ZONE_LABELS[code] ?? `防火地域コード: ${code}`;
      }
    }

    return result;
  }

  /** 複数の属性名候補から最初に存在する値を返す。存在しなければ null。 */
  private pick(
    props: Record<string, unknown>,
    keys: string[],
  ): unknown | null {
    for (const k of keys) {
      if (k in props && props[k] !== null && props[k] !== undefined) {
        return props[k];
      }
    }
    return null;
  }

  /** pick の数値版。NaN/null は null。 */
  private pickNumber(
    props: Record<string, unknown>,
    keys: string[],
  ): number | null {
    const v = this.pick(props, keys);
    if (v === null) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
}

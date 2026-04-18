/**
 * ReinfilibProvider
 *
 * 国土交通省 不動産情報ライブラリ タイル API を使って
 * 住所から都市計画情報を取得する。
 *
 * ── 必要な環境変数 ──────────────────────────────────────────────────────────
 *   REINFOLIB_API_KEY=<サブスクリプションキー>
 *   ヘッダー Ocp-Apim-Subscription-Key に自動セットされる。
 *   未設定時は InvestigationProvider のコンストラクタで throw し、
 *   オーケストレーターが fetch_failed として記録する。
 *
 * ── 利用エンドポイント ────────────────────────────────────────────────────
 *   いずれも GeoJSON タイル API。共通パラメータ:
 *     response_format=geojson  epsg=4326  z={z}  x={x}  y={y}
 *
 *   1. 国土地理院 住所検索 API（無料・認証不要）
 *      GET https://msearch.gsi.go.jp/address-search/AddressSearch?q={住所}
 *      → 住所を緯度経度・正規化住所に変換する
 *
 *   2. XKT002 — 用途地域
 *      GET {BASE}/XKT002?response_format=geojson&epsg=4326&z=&x=&y=
 *      → 用途地域 / 建蔽率 / 容積率 / 高度地区
 *      ※ 200 でも features が空配列の場合がある（市街化調整区域・白地等）
 *
 *   3. XKT014 — 防火・準防火地域
 *      GET {BASE}/XKT014?response_format=geojson&epsg=4326&z=&x=&y=
 *      → 防火地域 / 準防火地域 / 法22条区域
 *      ※ 200 でも features が空配列の場合がある（指定なしの地域）
 *
 *   ※ XPT001 は「不動産取引価格情報のポイントデータ」であり、
 *     用途地域・防火地域の取得には使用しない。
 *
 * ── 空データの扱い ────────────────────────────────────────────────────────
 *   - features が空配列 → そのフィールドは取得なし（エラーにしない）
 *   - 取得できなかったフィールドは InvestigationResult に含まれない
 *   - source には "国土交通省 不動産情報ライブラリ" を返す
 *
 * ── 属性名について ────────────────────────────────────────────────────────
 *   各 parseXxx() メソッドで複数の候補名を列挙している。
 *   API 仕様変更でフィールド名が変わった場合はそこを修正すること。
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

/**
 * タイルズームレベル。
 * 用途地域ポリゴンは z=14 以上で十分な解像度が得られる。
 * 細かすぎると 1 タイルに収まらない場合があるため 16 を基準とする。
 */
const ZOOM = 16;

/** XKT002 用途地域コード → 日本語ラベル */
const ZONE_LABELS: Record<string, string> = {
  "1":  "第一種低層住居専用地域",
  "2":  "第二種低層住居専用地域",
  "3":  "第一種中高層住居専用地域",
  "4":  "第二種中高層住居専用地域",
  "5":  "第一種住居地域",
  "6":  "第二種住居地域",
  "7":  "準住居地域",
  "8":  "田園住居地域",
  "9":  "近隣商業地域",
  "10": "商業地域",
  "11": "準工業地域",
  "12": "工業地域",
  "13": "工業専用地域",
};

/** XKT014 防火地域コード → 日本語ラベル */
const FIRE_LABELS: Record<string, string> = {
  "1": "防火地域",
  "2": "準防火地域",
  "3": "法22条区域",
};

// ── ユーティリティ ───────────────────────────────────────────────────────────

/**
 * "60%" や "60" のような文字列を数値に変換する。
 * パース不能な場合は null を返す。
 */
function parseRatioPercent(raw: string): number | null {
  const n = Number(raw.replace("%", "").trim());
  return isNaN(n) ? null : n;
}

// ── タイル座標変換 ───────────────────────────────────────────────────────────

function lngLatToTile(lat: number, lng: number, z: number): { x: number; y: number } {
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
    "国土交通省 不動産情報ライブラリ — XKT002(用途地域) / XKT014(防火地域)";
  readonly fields: (keyof InvestigationResult)[] = [
    "zoningDistrict",
    "buildingCoverageRatio",
    "floorAreaRatio",
    "firePreventionZone",
    // heightDistrict: 公式確認済みAPIなし。XKT024 等の仕様が確定次第追加する
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
      throw new Error(`住所のジオコーディングに失敗しました: "${query.address}"`);
    }

    const { x, y } = lngLatToTile(lat, lng, ZOOM);

    // 2. XKT002 — 用途地域・建蔽率・容積率・高度地区
    const zoningResult = await this.callTileApi("XKT002", x, y);

    // 3. XKT014 — 防火・準防火地域
    const fireResult = await this.callTileApi("XKT014", x, y);

    // 4. マージ
    const data: InvestigationResult = {
      ...this.parseZoning(zoningResult),
      ...this.parseFireZone(fireResult),
    };

    const emptyEndpoints: string[] = [];
    if ((zoningResult.features ?? []).length === 0) emptyEndpoints.push("XKT002(用途地域)");
    if ((fireResult.features ?? []).length === 0)   emptyEndpoints.push("XKT014(防火地域)");

    return {
      source: "国土交通省 不動産情報ライブラリ",
      data,
      meta: {
        normalizedAddress: geo?.title ?? null,
        geocodedLat: lat,
        geocodedLng: lng,
        geocodeSource: query.gpsLat != null ? "property-db" : "gsi",
        zoom: ZOOM,
        tileX: x,
        tileY: y,
        // 200 OK だが features 空だったエンドポイント（指定なし地域では正常）
        emptyEndpoints,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(
        `${REINFOLIB_BASE}/XKT002?response_format=geojson&epsg=4326&z=0&x=0&y=0`,
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

  /** 国土地理院 住所検索 API。失敗時は null を返す（例外を投げない）。 */
  private async geocode(
    address: string,
  ): Promise<{ lat: number; lng: number; title: string } | null> {
    try {
      const url = `${GSI_GEOCODE_URL}?q=${encodeURIComponent(address)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;
      const results: GsiFeature[] = await res.json();
      if (!Array.isArray(results) || results.length === 0) return null;
      const [lng, lat] = results[0].geometry.coordinates; // GeoJSON: [lng, lat]
      return { lat, lng, title: results[0].properties.title };
    } catch {
      return null;
    }
  }

  /**
   * REINFOLIB タイル API を呼び出す。
   * 200 OK でも features が空配列の場合がある（指定なし地域では正常）。
   * HTTP エラー時のみ throw する。
   */
  private async callTileApi(endpoint: string, x: number, y: number): Promise<GeoJsonFC> {
    const url =
      `${REINFOLIB_BASE}/${endpoint}` +
      `?response_format=geojson&epsg=4326&z=${ZOOM}&x=${x}&y=${y}`;

    const res = await fetch(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(
        `不動産情報ライブラリ ${endpoint} エラー: HTTP ${res.status} ${res.statusText}`,
      );
    }

    return res.json() as Promise<GeoJsonFC>;
  }

  /**
   * XKT002 (用途地域) GeoJSON → InvestigationResult
   *
   * features が空配列の場合は {} を返す（市街化調整区域・白地地域では正常）。
   *
   * 公式確認済み属性名:
   *   use_area_ja                  : 用途地域（日本語ラベル）
   *   u_building_coverage_ratio_ja : 建蔽率（"60%" 等の文字列）
   *   u_floor_area_ratio_ja        : 容積率（"200%" 等の文字列）
   *
   * heightDistrict は XKT002 からは取得しない。
   * 対応 API（XKT024 等）の仕様が公式確認できた時点で別メソッドを追加すること。
   */
  private parseZoning(fc: GeoJsonFC): InvestigationResult {
    const props = fc.features?.[0]?.properties;
    if (!props) return {}; // features 空 = 指定なし。エラーではない

    const result: InvestigationResult = {};

    // 用途地域（日本語ラベルをそのまま使う）
    const zoneRaw = this.pick(props, ["use_area_ja", "youto", "youto_cd"]);
    if (zoneRaw !== null) {
      const label = String(zoneRaw).trim();
      // 値がコード番号ならラベルに変換、すでに日本語ならそのまま
      result.zoningDistrict = ZONE_LABELS[label] ?? label;
    }

    // 建蔽率（"60%" → 60 に変換）
    const bcrRaw = this.pick(props, ["u_building_coverage_ratio_ja", "kenpei", "kenpei_ritsu"]);
    if (bcrRaw !== null) {
      const n = parseRatioPercent(String(bcrRaw));
      if (n !== null && n > 0) result.buildingCoverageRatio = n;
    }

    // 容積率（"200%" → 200 に変換）
    const farRaw = this.pick(props, ["u_floor_area_ratio_ja", "yoseki", "yoseki_ritsu"]);
    if (farRaw !== null) {
      const n = parseRatioPercent(String(farRaw));
      if (n !== null && n > 0) result.floorAreaRatio = n;
    }

    return result;
  }

  /**
   * XKT014 (防火・準防火地域) GeoJSON → InvestigationResult
   *
   * features が空配列の場合は {} を返す（防火指定なしの地域では正常）。
   *
   * 属性名候補:
   *   防火種別コード: bouka / bouka_cd / 防火地域 / 防火種別
   */
  private parseFireZone(fc: GeoJsonFC): InvestigationResult {
    const props = fc.features?.[0]?.properties;
    if (!props) return {}; // features 空 = 防火指定なし。エラーではない

    const result: InvestigationResult = {};

    const fireRaw = this.pick(props, ["bouka", "bouka_cd", "防火地域", "防火種別"]);
    if (fireRaw !== null) {
      const code = String(fireRaw).trim();
      if (code !== "0" && code !== "") {
        result.firePreventionZone = FIRE_LABELS[code] ?? code;
      }
    }

    return result;
  }

  /** 複数の属性名候補から最初に存在する値を返す。なければ null。 */
  private pick(props: Record<string, unknown>, keys: string[]): unknown | null {
    for (const k of keys) {
      if (k in props && props[k] !== null && props[k] !== undefined) return props[k];
    }
    return null;
  }

  /** pick の数値版。NaN は null。 */
  private pickNum(props: Record<string, unknown>, keys: string[]): number | null {
    const v = this.pick(props, keys);
    if (v === null) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
}

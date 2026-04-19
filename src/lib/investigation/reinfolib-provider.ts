/**
 * ReinfilibProvider
 *
 * 国土交通省 不動産情報ライブラリ タイル API を使って
 * 住所から都市計画・ハザード・道路情報を取得する。
 *
 * ── 必要な環境変数 ──────────────────────────────────────────────────────────
 *   REINFOLIB_API_KEY=<サブスクリプションキー>
 *   ヘッダー Ocp-Apim-Subscription-Key に自動セットされる。
 *
 * ── URL 形式（公式マニュアル準拠）────────────────────────────────────────────
 *   GET {BASE}/{endpoint}?response_format=geojson&z={z}&x={x}&y={y}
 *   z/x/y はクエリパラメータ（パスセグメントではない）。
 *
 *   curl 再現例（z=16, x=58192, y=25816 は東京都心付近）:
 *     curl -H "Ocp-Apim-Subscription-Key: <KEY>" \
 *       "https://www.reinfolib.mlit.go.jp/ex-api/external/XKT002?response_format=geojson&z=16&x=58192&y=25816"
 *
 * ── 利用エンドポイント一覧 ───────────────────────────────────────────────────
 *
 *   GSI 住所検索 (認証不要)
 *     GET https://msearch.gsi.go.jp/address-search/AddressSearch?q={住所}
 *     → 住所を緯度経度・正規化住所に変換する
 *
 *   XKT002 — 用途地域
 *     → zoningDistrict / buildingCoverageRatio / floorAreaRatio
 *
 *   XKT014 — 防火・準防火地域
 *     → firePreventionZone（防火 / 準防火 / 法22条区域）
 *
 *   XKT025 — 液状化危険度
 *     → liquefactionRiskLevel
 *     ※ XKT025 は液状化。洪水浸水想定とは別エンドポイント。
 *
 *   XKT026 — 洪水浸水想定区域
 *     → floodRiskLevel
 *
 *   XKT027 — 高潮浸水想定区域
 *     → stormSurgeRiskLevel
 *
 *   XKT028 — 津波浸水想定区域
 *     → tsunamiRiskLevel
 *
 *   XKT029 — 土砂災害警戒区域
 *     → sedimentRiskCategory
 *     ※ XKT016 は「災害危険区域」であり土砂災害警戒区域の代用には使用しない。
 *
 *   XKT030 — 道路情報
 *     → roadType / roadWidth
 *
 * ── 空データの扱い ────────────────────────────────────────────────────────
 *   - features 空配列 → 指定なし地域（正常）。そのフィールドは null のまま。
 *   - HTTP 404/400 → URL 形式 / エンドポイント誤りの可能性が高い → error 扱い。
 *   - タイル API エラーは個別 catch → meta.tileErrors に記録し provider は success 扱い
 *     （GSI ジオコーディング成功時は座標を常に保存するため）。
 *
 * ── 属性名について ────────────────────────────────────────────────────────
 *   XKT002/XKT014 は公式確認済み属性名を使用。
 *   ハザード系 (XKT025〜030) の正式属性名は未確定のため各 parseXxx() で
 *   複数候補を列挙し、一致しない場合は "指定あり" を返す。
 *   本番ログ raw_payload_json.providers[reinfolib].meta で実属性名を確認し
 *   candidates を修正すること。
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
 * z=16 で HTTP 400 が発生したため z=15 に変更。
 * REINFOLIB タイル系 API (XKT002 等) は z=15 が推奨される解像度。
 * 変更する場合はここだけ修正すればよい。
 */
const ZOOM = 15;

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

type Ring = [number, number][];

interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: Ring[];
}

interface GeoJsonMultiPolygon {
  type: "MultiPolygon";
  coordinates: Ring[][];
}

type GeoJsonGeometry =
  | GeoJsonPolygon
  | GeoJsonMultiPolygon
  | { type: string; coordinates: unknown };

interface GeoJsonFeature {
  type: string;
  properties: Record<string, unknown>;
  geometry?: GeoJsonGeometry | null;
}

interface GeoJsonFC {
  type: string;
  features?: GeoJsonFeature[];
}

/** parseZoning が返す空間選択の詳細。raw_payload_json.providers[reinfolib].meta.zoning に格納される。 */
interface ZoningMeta {
  returnedFeatureCount: number;
  spatialMatchCount: number;
  matchedFeatureIndex: number | null;
  matchedUseAreaJa: string | null;
  selectionReason: string;
}

// ── 空間ユーティリティ ────────────────────────────────────────────────────────

/** Ray-casting: 点 (lng, lat) がリング内にあるか判定する。 */
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 点 (lng, lat) が Polygon の外周リング内にあるか判定する（ホール無視）。 */
function pointInPolygon(lng: number, lat: number, coords: Ring[]): boolean {
  return coords.length > 0 && pointInRing(lng, lat, coords[0]);
}

/** 点 (lng, lat) が GeoJSON ジオメトリに含まれるか判定する。 */
function pointInGeometry(lng: number, lat: number, geom: GeoJsonGeometry): boolean {
  if (geom.type === "Polygon") {
    return pointInPolygon(lng, lat, (geom as GeoJsonPolygon).coordinates);
  }
  if (geom.type === "MultiPolygon") {
    return (geom as GeoJsonMultiPolygon).coordinates.some((poly) =>
      pointInPolygon(lng, lat, poly),
    );
  }
  return false;
}

/** Shoelace 公式でリングの近似面積（lng/lat 二乗単位）を返す。 */
function ringArea(ring: Ring): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(area / 2);
}

/** ジオメトリの近似面積を返す（小さいほど絞り込み済みの polygon）。 */
function geometryApproxArea(geom: GeoJsonGeometry): number {
  if (geom.type === "Polygon") {
    return ringArea((geom as GeoJsonPolygon).coordinates[0] ?? []);
  }
  if (geom.type === "MultiPolygon") {
    return (geom as GeoJsonMultiPolygon).coordinates.reduce(
      (sum, poly) => sum + ringArea(poly[0] ?? []),
      0,
    );
  }
  return Infinity;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class ReinfilibProvider implements InvestigationProvider {
  readonly name = "reinfolib";
  readonly description =
    "国土交通省 不動産情報ライブラリ — " +
    "XKT002(用途地域) / XKT014(防火) / XKT025(液状化) / " +
    "XKT026(洪水) / XKT027(高潮) / XKT028(津波) / XKT029(土砂) / XKT030(道路)";
  readonly fields: (keyof InvestigationResult)[] = [
    "zoningDistrict",
    "buildingCoverageRatio",
    "floorAreaRatio",
    "firePreventionZone",
    "liquefactionRiskLevel",
    "floodRiskLevel",
    "stormSurgeRiskLevel",
    "tsunamiRiskLevel",
    "sedimentRiskCategory",
    "roadType",
    "roadWidth",
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

    // meta はタイルAPIの成否に関わらず常に設定する。
    // GSI ジオコーディングが成功している限り、タイルAPIが失敗しても
    // normalized_address / latitude / longitude は service 層で保存される。
    const baseMeta: Record<string, unknown> = {
      normalizedAddress: geo?.title ?? null,
      geocodedLat: lat,
      geocodedLng: lng,
      geocodeSource: query.gpsLat != null ? "property-db" : "gsi",
      zoom: ZOOM,
      tileX: x,
      tileY: y,
    };

    // 2. 全タイルAPIを並列呼び出し
    //    タイルAPIエラーは tryCall 内で catch → tileErrors に記録し空 FC を返す。
    //    throw しないことで fetch() 全体は成功扱いになり meta が service 層に渡る。
    //    HTTP 404/400 は URL 形式誤りの可能性が高いため throw（error 扱い）。
    const EMPTY: GeoJsonFC = { type: "FeatureCollection", features: [] };
    const tileErrors: string[] = [];

    const tryCall = async (ep: string): Promise<GeoJsonFC> => {
      try {
        return await this.callTileApi(ep, x, y);
      } catch (err) {
        tileErrors.push(err instanceof Error ? err.message : String(err));
        return EMPTY;
      }
    };

    const [
      zoningResult,       // XKT002 用途地域
      fireResult,         // XKT014 防火地域
      liquefactionResult, // XKT025 液状化危険度
      floodResult,        // XKT026 洪水浸水想定
      stormResult,        // XKT027 高潮浸水想定
      tsunamiResult,      // XKT028 津波浸水想定
      sedimentResult,     // XKT029 土砂災害警戒
      roadResult,         // XKT030 道路情報
    ] = await Promise.all([
      tryCall("XKT002"),
      tryCall("XKT014"),
      tryCall("XKT025"),
      tryCall("XKT026"),
      tryCall("XKT027"),
      tryCall("XKT028"),
      tryCall("XKT029"),
      tryCall("XKT030"),
    ]);

    // 3. マージ
    const zoningParsed = this.parseZoning(zoningResult, lng, lat);
    const data: InvestigationResult = {
      ...zoningParsed.data,
      ...this.parseFireZone(fireResult),
      ...this.parseLiquefaction(liquefactionResult),
      ...this.parseFlood(floodResult),
      ...this.parseStormSurge(stormResult),
      ...this.parseTsunami(tsunamiResult),
      ...this.parseSediment(sedimentResult),
      ...this.parseRoad(roadResult),
    };

    // 200 OK だが features 空だったエンドポイント（指定なし地域では正常）
    const emptyEndpoints = (
      [
        ["XKT002(用途地域)",   zoningResult],
        ["XKT014(防火地域)",   fireResult],
        ["XKT025(液状化)",     liquefactionResult],
        ["XKT026(洪水浸水)",   floodResult],
        ["XKT027(高潮浸水)",   stormResult],
        ["XKT028(津波浸水)",   tsunamiResult],
        ["XKT029(土砂災害)",   sedimentResult],
        ["XKT030(道路情報)",   roadResult],
      ] as [string, GeoJsonFC][]
    )
      .filter(([, fc]) => (fc.features ?? []).length === 0)
      .map(([name]) => name);

    return {
      source: "国土交通省 不動産情報ライブラリ",
      data,
      meta: {
        ...baseMeta,
        zoning: zoningParsed.meta,
        emptyEndpoints,
        ...(tileErrors.length > 0 && { tileErrors }),
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(
        `${REINFOLIB_BASE}/XKT002?response_format=geojson&z=0&x=0&y=0`,
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
   *
   * URL 形式（公式マニュアル準拠）:
   *   GET {BASE}/{endpoint}?response_format=geojson&z={z}&x={x}&y={y}
   *   z/x/y はクエリパラメータ（パスセグメントではない）。
   *
   * curl 再現例:
   *   curl -H "Ocp-Apim-Subscription-Key: <KEY>" \
   *     "https://www.reinfolib.mlit.go.jp/ex-api/external/XKT026?response_format=geojson&z=16&x=58192&y=25816"
   *
   * ログ出力:
   *   [reinfolib] {endpoint} → {url}           ← リクエスト前（debug）
   *   [reinfolib] {endpoint} HTTP {status} | features: {N}  ← 成功時（debug）
   *   [reinfolib] {endpoint} HTTP {status} | URL: {url} | body: {body}  ← エラー時（error）
   *
   * 200 OK でも features が空配列の場合がある（指定なし地域では正常）。
   * HTTP 4xx/5xx は URL 形式 / エンドポイント誤りの可能性が高いため throw する。
   */
  private async callTileApi(endpoint: string, x: number, y: number): Promise<GeoJsonFC> {
    const url =
      `${REINFOLIB_BASE}/${endpoint}` +
      `?response_format=geojson&z=${ZOOM}&x=${x}&y=${y}`;

    console.debug(
      `[reinfolib] ${endpoint} z=${ZOOM} x=${x} y=${y} → ${url}`,
    );

    const res = await fetch(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[reinfolib] ${endpoint} HTTP ${res.status} | z=${ZOOM} x=${x} y=${y} | URL: ${url} | body: ${body.slice(0, 500)}`,
      );
      throw new Error(
        `不動産情報ライブラリ ${endpoint} エラー: HTTP ${res.status} ${res.statusText}` +
          (body ? ` — ${body.slice(0, 200)}` : ""),
      );
    }

    const json = await res.json() as GeoJsonFC;
    console.debug(
      `[reinfolib] ${endpoint} HTTP ${res.status} | z=${ZOOM} x=${x} y=${y} | features: ${(json.features ?? []).length}`,
    );
    return json;
  }

  // ── Parse methods ─────────────────────────────────────────────────────────

  /**
   * XKT002 (用途地域) GeoJSON → { data, meta }
   *
   * features に含まれる polygon のうち点 (lng, lat) を含むものだけを候補にし、
   * 空間的に一致する feature の属性を採用する。
   *
   * 選択ロジック:
   *   - 一致 0 件 → zoningDistrict 等は保存しない
   *   - 一致 1 件 → そのまま採用
   *   - 一致複数:
   *       - 全候補で use_area_ja が同一 → 最小面積 polygon を採用
   *       - use_area_ja が異なる → 保存しない（確信が持てない）
   *
   * 公式確認済み属性名:
   *   use_area_ja                  : 用途地域（日本語ラベル）
   *   u_building_coverage_ratio_ja : 建蔽率（"60%" 等の文字列）
   *   u_floor_area_ratio_ja        : 容積率（"200%" 等の文字列）
   */
  private parseZoning(
    fc: GeoJsonFC,
    lng: number,
    lat: number,
  ): { data: InvestigationResult; meta: ZoningMeta } {
    const features = fc.features ?? [];
    const returnedFeatureCount = features.length;

    // 空間フィルタ: 点を含む feature のみ候補に
    const spatialMatches = features
      .map((feature, index) => ({ feature, index }))
      .filter(({ feature }) =>
        !!feature.geometry && pointInGeometry(lng, lat, feature.geometry),
      );

    const spatialMatchCount = spatialMatches.length;
    let matchedFeatureIndex: number | null = null;
    let matchedUseAreaJa: string | null = null;
    let selectionReason: string;
    const data: InvestigationResult = {};

    const extractFields = (props: Record<string, unknown>): void => {
      const zoneRaw = this.pick(props, ["use_area_ja", "youto", "youto_cd"]);
      if (zoneRaw !== null) {
        const label = String(zoneRaw).trim();
        data.zoningDistrict = ZONE_LABELS[label] ?? label;
      }
      const bcrRaw = this.pick(props, ["u_building_coverage_ratio_ja", "kenpei", "kenpei_ritsu"]);
      if (bcrRaw !== null) {
        const n = parseRatioPercent(String(bcrRaw));
        if (n !== null && n > 0) data.buildingCoverageRatio = n;
      }
      const farRaw = this.pick(props, ["u_floor_area_ratio_ja", "yoseki", "yoseki_ritsu"]);
      if (farRaw !== null) {
        const n = parseRatioPercent(String(farRaw));
        if (n !== null && n > 0) data.floorAreaRatio = n;
      }
    };

    if (spatialMatchCount === 0) {
      selectionReason =
        returnedFeatureCount === 0 ? "no features returned" : "no spatial match";
    } else if (spatialMatchCount === 1) {
      const { feature, index } = spatialMatches[0];
      matchedFeatureIndex = index;
      matchedUseAreaJa =
        (this.pick(feature.properties, ["use_area_ja"]) as string | null) ?? null;
      selectionReason = "unique spatial match";
      extractFields(feature.properties);
    } else {
      // 複数候補: 面積昇順でソート
      const sorted = spatialMatches.slice().sort((a, b) => {
        const aArea = a.feature.geometry
          ? geometryApproxArea(a.feature.geometry)
          : Infinity;
        const bArea = b.feature.geometry
          ? geometryApproxArea(b.feature.geometry)
          : Infinity;
        return aArea - bArea;
      });

      const smallest = sorted[0];
      // 全候補の use_area_ja が同じか確認
      const zones = sorted.map(
        ({ feature }) =>
          (this.pick(feature.properties, ["use_area_ja", "youto", "youto_cd"]) as string | null) ??
          null,
      );
      const allSameZone = zones.every((z) => z === zones[0]);

      if (allSameZone) {
        matchedFeatureIndex = smallest.index;
        matchedUseAreaJa =
          (this.pick(smallest.feature.properties, ["use_area_ja"]) as string | null) ?? null;
        selectionReason = `multiple matches (${spatialMatchCount}), same zone, picked smallest area`;
        extractFields(smallest.feature.properties);
      } else {
        // ゾーンが異なる → 保存しない
        matchedFeatureIndex = smallest.index;
        matchedUseAreaJa =
          (this.pick(smallest.feature.properties, ["use_area_ja"]) as string | null) ?? null;
        selectionReason = `multiple matches (${spatialMatchCount}), different zones, zoning not saved`;
      }
    }

    return {
      data,
      meta: {
        returnedFeatureCount,
        spatialMatchCount,
        matchedFeatureIndex,
        matchedUseAreaJa,
        selectionReason,
      },
    };
  }

  /**
   * XKT014 (防火・準防火地域) GeoJSON → InvestigationResult
   *
   * 公式確認済み属性名:
   *   fire_prevention_ja : 防火地域区分（日本語ラベル）← 最優先
   *   kubun_id           : 区分ID（コード値のフォールバック）
   */
  private parseFireZone(fc: GeoJsonFC): InvestigationResult {
    const props = fc.features?.[0]?.properties;
    if (!props) return {};

    const fireRaw = this.pick(props, ["fire_prevention_ja", "kubun_id"]);
    if (fireRaw === null) return {};
    const label = String(fireRaw).trim();
    if (label === "0" || label === "") return {};
    return { firePreventionZone: FIRE_LABELS[label] ?? label };
  }

  /**
   * XKT025 (液状化危険度) → liquefactionRiskLevel
   * features 空 = 指定なし。属性名未確定のため candidates で試行する。
   */
  private parseLiquefaction(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const raw = this.pick(props, [
      "rank_ja", "rank", "class_ja", "class",
      "ekijoka_rank", "liquefaction_rank", "description",
    ]);
    return { liquefactionRiskLevel: raw != null ? String(raw) : "指定あり" };
  }

  /**
   * XKT026 (洪水浸水想定区域) → floodRiskLevel
   * features 空 = 区域外。属性名未確定のため candidates で試行する。
   */
  private parseFlood(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const raw = this.pick(props, [
      "scale", "shinsui_scale", "depth_scale",
      "class_ja", "rank_ja", "description",
    ]);
    return { floodRiskLevel: raw != null ? String(raw) : "指定あり" };
  }

  /**
   * XKT027 (高潮浸水想定区域) → stormSurgeRiskLevel
   */
  private parseStormSurge(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const raw = this.pick(props, [
      "scale", "depth_scale", "takashio_scale",
      "class_ja", "rank_ja",
    ]);
    return { stormSurgeRiskLevel: raw != null ? String(raw) : "指定あり" };
  }

  /**
   * XKT028 (津波浸水想定区域) → tsunamiRiskLevel
   */
  private parseTsunami(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const raw = this.pick(props, [
      "scale", "depth_scale", "tsunami_scale",
      "class_ja", "rank_ja",
    ]);
    return { tsunamiRiskLevel: raw != null ? String(raw) : "指定あり" };
  }

  /**
   * XKT029 (土砂災害警戒区域) → sedimentRiskCategory
   * ※ XKT016 は「災害危険区域」であり土砂災害警戒区域ではない。使用しないこと。
   * kubun_id 候補: 1=土砂災害警戒区域 / 2=土砂災害特別警戒区域
   */
  private parseSediment(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const raw = this.pick(props, [
      "kubun_ja", "kubun_id", "category_ja", "type_ja",
      "saigai_kubun", "dosya_kubun",
    ]);
    if (raw === null) return { sedimentRiskCategory: "指定あり" };
    const s = String(raw);
    if (s === "1") return { sedimentRiskCategory: "土砂災害警戒区域" };
    if (s === "2") return { sedimentRiskCategory: "土砂災害特別警戒区域" };
    return { sedimentRiskCategory: s };
  }

  /**
   * XKT030 (道路情報) → roadType / roadWidth
   * 属性名未確定のため candidates で試行する。
   */
  private parseRoad(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const result: InvestigationResult = {};
    const typeRaw = this.pick(props, [
      "road_type_ja", "road_type", "douro_kubun_ja", "douro_kubun",
    ]);
    if (typeRaw != null) result.roadType = String(typeRaw);
    const widthRaw = this.pickNum(props, [
      "width_m", "road_width", "douro_width", "width",
    ]);
    if (widthRaw != null && widthRaw > 0) result.roadWidth = widthRaw;
    return result;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

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

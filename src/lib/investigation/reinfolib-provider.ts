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
 *   URL 形式（公式マニュアル準拠）:
 *     GET {BASE}/{endpoint}?response_format=geojson&z={z}&x={x}&y={y}
 *   z/x/y はクエリパラメータ（パスセグメントではない）。
 *
 *   curl 再現例（z=16, x=58192, y=25816 は東京都心付近）:
 *     curl -H "Ocp-Apim-Subscription-Key: <KEY>" \
 *       "https://www.reinfolib.mlit.go.jp/ex-api/external/XKT002?response_format=geojson&z=16&x=58192&y=25816"
 *
 *   1. 国土地理院 住所検索 API（無料・認証不要）
 *      GET https://msearch.gsi.go.jp/address-search/AddressSearch?q={住所}
 *      → 住所を緯度経度・正規化住所に変換する
 *
 *   2. XKT002 — 用途地域
 *      → 用途地域 / 建蔽率 / 容積率
 *      ※ 200 でも features 空配列あり（市街化調整区域・白地等）
 *
 *   3. XKT014 — 防火・準防火地域
 *      → 防火地域 / 準防火地域 / 法22条区域
 *      ※ 200 でも features 空配列あり（指定なし地域）
 *
 *   4. XKT025 — 洪水浸水想定区域
 *      → floodRiskLevel（深さスケール or "指定あり"）
 *
 *   5. XKT016 — 土砂災害警戒区域
 *      → sedimentRiskCategory（区分ラベル or "指定あり"）
 *
 *   6. XKT026 — 津波浸水想定区域
 *      → tsunamiRiskLevel（深さスケール or "指定あり"）
 *
 *   7. XKT027 — 高潮浸水想定区域
 *      → stormSurgeRiskLevel（深さスケール or "指定あり"）
 *
 *   8. XKT030 — 道路情報
 *      → roadType / roadWidth（道路種別・幅員）
 *
 * ── 空データの扱い ────────────────────────────────────────────────────────
 *   - features が空配列 → そのフィールドは取得なし（エラーにしない）
 *   - タイルAPI エラーは個別 catch → tileErrors に記録し provider は success 扱い
 *     （GSI ジオコーディング成功時は座標を常に保存するため）
 *   - source には "国土交通省 不動産情報ライブラリ" を返す
 *
 * ── 属性名について ────────────────────────────────────────────────────────
 *   ハザード系 API (XKT025/016/026/027/030) の正式属性名は未確定のため
 *   各 parseXxx() メソッドで複数の候補名を列挙している。
 *   candidates に一致しない場合は "指定あり" を返す（フィールド存在は確認済み）。
 *   API 仕様変更・属性名確定時はそこを修正すること。
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
    "floodRiskLevel",
    "sedimentRiskCategory",
    "tsunamiRiskLevel",
    "stormSurgeRiskLevel",
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
      zoningResult,   // XKT002 用途地域
      fireResult,     // XKT014 防火地域
      floodResult,    // XKT025 洪水浸水想定
      sedimentResult, // XKT016 土砂災害警戒
      tsunamiResult,  // XKT026 津波浸水想定
      stormResult,    // XKT027 高潮浸水想定
      roadResult,     // XKT030 道路情報
    ] = await Promise.all([
      tryCall("XKT002"),
      tryCall("XKT014"),
      tryCall("XKT025"),
      tryCall("XKT016"),
      tryCall("XKT026"),
      tryCall("XKT027"),
      tryCall("XKT030"),
    ]);

    // 3. マージ
    const data: InvestigationResult = {
      ...this.parseZoning(zoningResult),
      ...this.parseFireZone(fireResult),
      ...this.parseFlood(floodResult),
      ...this.parseSediment(sedimentResult),
      ...this.parseTsunami(tsunamiResult),
      ...this.parseStormSurge(stormResult),
      ...this.parseRoad(roadResult),
    };

    // 200 OK だが features 空だったエンドポイント（指定なし地域では正常）
    const emptyEndpoints = (
      [
        ["XKT002(用途地域)",   zoningResult],
        ["XKT014(防火地域)",   fireResult],
        ["XKT025(洪水浸水)",   floodResult],
        ["XKT016(土砂災害)",   sedimentResult],
        ["XKT026(津波浸水)",   tsunamiResult],
        ["XKT027(高潮浸水)",   stormResult],
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
        emptyEndpoints,
        ...(tileErrors.length > 0 && { tileErrors }),
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
   *
   * URL 形式（公式マニュアル準拠）:
   *   /{endpoint}?response_format=geojson&z={z}&x={x}&y={y}
   *   z/x/y はクエリパラメータ（パスセグメントではない）。
   *
   * curl 再現例:
   *   curl -H "Ocp-Apim-Subscription-Key: <KEY>" \
   *     "https://www.reinfolib.mlit.go.jp/ex-api/external/XKT002?response_format=geojson&z=16&x=58192&y=25816"
   *   curl -H "Ocp-Apim-Subscription-Key: <KEY>" \
   *     "https://www.reinfolib.mlit.go.jp/ex-api/external/XKT014?response_format=geojson&z=16&x=58192&y=25816"
   *
   * 200 OK でも features が空配列の場合がある（指定なし地域では正常）。
   * HTTP エラー時のみ throw する。
   */
  private async callTileApi(endpoint: string, x: number, y: number): Promise<GeoJsonFC> {
    const url =
      `${REINFOLIB_BASE}/${endpoint}` +
      `?response_format=geojson&z=${ZOOM}&x=${x}&y=${y}`;

    console.debug(`[reinfolib] ${endpoint} → ${url}`);

    const res = await fetch(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[reinfolib] ${endpoint} HTTP ${res.status} | URL: ${url} | body: ${body.slice(0, 500)}`,
      );
      throw new Error(
        `不動産情報ライブラリ ${endpoint} エラー: HTTP ${res.status} ${res.statusText}` +
          (body ? ` — ${body.slice(0, 200)}` : ""),
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
   * 公式確認済み属性名:
   *   fire_prevention_ja : 防火地域区分（日本語ラベル）← 最優先
   *   kubun_id           : 区分ID（コード値のフォールバック）
   */
  private parseFireZone(fc: GeoJsonFC): InvestigationResult {
    const props = fc.features?.[0]?.properties;
    if (!props) return {}; // features 空 = 防火指定なし。エラーではない

    const result: InvestigationResult = {};

    const fireRaw = this.pick(props, ["fire_prevention_ja", "kubun_id"]);
    if (fireRaw !== null) {
      const label = String(fireRaw).trim();
      if (label !== "0" && label !== "") {
        // fire_prevention_ja はすでに日本語ラベルのためそのまま使う。
        // kubun_id がコード値の場合は FIRE_LABELS で変換し、未知なら値をそのまま残す。
        result.firePreventionZone = FIRE_LABELS[label] ?? label;
      }
    }

    return result;
  }

  /**
   * XKT025 (洪水浸水想定区域) → floodRiskLevel
   * features 空 = 区域外。属性名未確定のため candidates で試行し、
   * 一致しない場合は "指定あり" を返す。
   */
  private parseFlood(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const raw = this.pick(props, ["scale", "shinsui_scale", "depth_scale", "class_ja", "rank_ja", "description"]);
    return { floodRiskLevel: raw != null ? String(raw) : "指定あり" };
  }

  /**
   * XKT016 (土砂災害警戒区域) → sedimentRiskCategory
   * kubun_id: 1=警戒区域 / 2=特別警戒区域
   */
  private parseSediment(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const raw = this.pick(props, ["kubun_ja", "kubun_id", "category_ja", "type_ja", "saigai_kubun"]);
    if (raw === null) return { sedimentRiskCategory: "指定あり" };
    const s = String(raw);
    if (s === "1") return { sedimentRiskCategory: "土砂災害警戒区域" };
    if (s === "2") return { sedimentRiskCategory: "土砂災害特別警戒区域" };
    return { sedimentRiskCategory: s };
  }

  /**
   * XKT026 (津波浸水想定区域) → tsunamiRiskLevel
   */
  private parseTsunami(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const raw = this.pick(props, ["scale", "depth_scale", "tsunami_scale", "class_ja", "rank_ja"]);
    return { tsunamiRiskLevel: raw != null ? String(raw) : "指定あり" };
  }

  /**
   * XKT027 (高潮浸水想定区域) → stormSurgeRiskLevel
   */
  private parseStormSurge(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const raw = this.pick(props, ["scale", "depth_scale", "takashio_scale", "class_ja", "rank_ja"]);
    return { stormSurgeRiskLevel: raw != null ? String(raw) : "指定あり" };
  }

  /**
   * XKT030 (道路情報) → roadType / roadWidth
   * 属性名未確定のため candidates で試行する。
   */
  private parseRoad(fc: GeoJsonFC): InvestigationResult {
    if ((fc.features ?? []).length === 0) return {};
    const props = fc.features![0].properties;
    const result: InvestigationResult = {};
    const typeRaw = this.pick(props, ["road_type_ja", "road_type", "douro_kubun_ja", "douro_kubun"]);
    if (typeRaw != null) result.roadType = String(typeRaw);
    const widthRaw = this.pickNum(props, ["width_m", "road_width", "douro_width", "width"]);
    if (widthRaw != null && widthRaw > 0) result.roadWidth = widthRaw;
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

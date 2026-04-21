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
 *   複数候補を列挙する。候補に一致しない場合は null（保存しない）とする。
 *   本番ログ raw_payload_json.providers[reinfolib].meta で実属性名を確認し
 *   candidates を修正すること。
 *   ※ 属性不明時に "指定あり" を保存する挙動は廃止済み（誤値防止）。
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

/**
 * タイル API のリトライ上限（最大試行回数 = MAX_TILE_RETRIES + 1）。
 * 対象: ネットワーク失敗・タイムアウト・HTTP 5xx（一時失敗）のみ。
 * 対象外: HTTP 4xx（恒久失敗 — URL 形式 / 認証エラー）。
 */
const MAX_TILE_RETRIES = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export interface GeoJsonFeature {
  type: string;
  properties: Record<string, unknown>;
  geometry?: GeoJsonGeometry | null;
}

export interface GeoJsonFC {
  type: string;
  features?: GeoJsonFeature[];
}

/** 空間一致した各 feature の属性サマリ。ZoningMeta.candidateSummaries の要素。 */
export interface ZoningCandidateInfo {
  featureIndex: number;
  useAreaJa: string | null;
  buildingCoverageRatioJa: string | null;
  floorAreaRatioJa: string | null;
  geometryType: string;
  approxArea: number;
}

/**
 * parseZoningFC が返す空間選択の詳細。
 * raw_payload_json.providers[reinfolib].meta.zoning に格納される。
 */
export interface ZoningMeta {
  /** XKT002 が返した features の総数。 */
  returnedFeatureCount: number;
  /** 点を含む feature の数（空間フィルタ後）。 */
  spatialMatchCount: number;
  /** 空間一致した全候補の属性サマリ（選択ロジック監査用）。 */
  candidateSummaries: ZoningCandidateInfo[];
  /** 空間一致した feature の index 一覧（features 配列基準）。 */
  matchedFeatureIndexes: number[];
  /** 採用した feature の use_area_ja 生値。保存しなかった場合は null。 */
  selectedUseAreaJa: string | null;
  /** 採用した建蔽率（数値）。保存しなかった場合は null。 */
  selectedBuildingCoverageRatio: number | null;
  /** 採用した容積率（数値）。保存しなかった場合は null。 */
  selectedFloorAreaRatio: number | null;
  /**
   * 選択結果の理由。保留になった場合も必ず記録する。
   * 値例: "unique spatial match" / "multiple matches but same zoning values" /
   *       "no spatial match" / "no features returned" /
   *       "conflicting zoning candidates" / "conflicting ratio candidates" /
   *       "insufficient candidate attributes"
   */
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

// ── module-level attribute helpers ─────────────────────────────────────────

/**
 * 複数の属性名候補から最初に存在する値を文字列で返す。
 * 値が null / undefined の場合は次のキーを試し、なければ null。
 */
function pickStr(props: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = props[k];
    if (v !== null && v !== undefined) return String(v);
  }
  return null;
}

// ── 汎用 endpoint メタ型 ─────────────────────────────────────────────────────

/**
 * XKT014/025~030 各 endpoint が返す空間選択の詳細。
 * raw_payload_json.providers[reinfolib].meta.<endpoint> に格納される。
 *
 * selectionReason の値:
 *   "unique spatial match"               — 1 件一致、明示的な属性値を採用
 *   "multiple matches, same value"       — 複数一致・全値同一、採用
 *   "no spatial match"                   — features はあるが点を含まない
 *   "no features returned"               — features 空（指定なし地域）
 *   "conflicting candidates"             — 複数一致・意味値が異なる
 *   "insufficient candidate attributes"  — 複数一致・属性欠損で比較不能
 *   "explicit value not resolved"        — 1 件一致・属性が取得できず保存しない
 */
export interface EndpointSpatialMeta {
  returnedFeatureCount: number;
  spatialMatchCount: number;
  /** 採用した feature の元 features[] 上の index。採用なしの場合 null。 */
  matchedFeatureIndex: number | null;
  selectionReason: string;
  /**
   * selectionReason が "explicit value not resolved" のとき、マッチした feature が
   * 持っていた全プロパティキーを記録する。
   * raw_payload_json に保存されるため VPS ログなしで DB から実属性名を確認できる。
   */
  unresolvedKeys?: string[];
  /**
   * selectionReason が "explicit value not resolved" のとき、マッチした feature の
   * key→value を記録する（primitive 値のみ。文字列は 200 文字で打ち切り）。
   * unresolvedKeys と合わせて実値を DB から直接確認するために使う。
   * 候補キー追加の判断材料にのみ使用し、値の推測保存には使わない。
   */
  unresolvedKeyValues?: Record<string, string | number | boolean | null>;
}

/**
 * feature.properties から primitive 値（string/number/boolean/null）だけを抽出する。
 * object/array/undefined は除外。文字列は MAX_UNRESOLVED_VALUE_LEN 文字で打ち切る。
 * unresolvedKeyValues の肥大化防止のみが目的。値を解釈・正規化しない。
 */
const MAX_UNRESOLVED_VALUE_LEN = 200;

function toPrimitiveProps(
  props: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || typeof v === "boolean" || typeof v === "number") {
      result[k] = v;
    } else if (typeof v === "string") {
      result[k] = v.length <= MAX_UNRESOLVED_VALUE_LEN
        ? v
        : v.slice(0, MAX_UNRESOLVED_VALUE_LEN) + "…";
    }
    // object / array / undefined は除外
  }
  return result;
}

/**
 * XKT014/025~029 に共通の「空間一致 1 点選択」ヘルパー（内部用）。
 *
 * extractRaw: props → 確定した意味値文字列。属性不明・対象外 → null。
 *   - null を返した場合は保存しない（selectionReason: "explicit value not resolved"）。
 *   - 確定できた明示的な値だけを保存する。推測値・曖昧値は返さない。
 */
function resolveByPoint(
  fc: GeoJsonFC,
  lng: number,
  lat: number,
  extractRaw: (props: Record<string, unknown>) => string | null,
): { value: string | null; meta: EndpointSpatialMeta } {
  const features = fc.features ?? [];
  const returnedFeatureCount = features.length;

  const matches = features
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) =>
      feature.geometry != null && pointInGeometry(lng, lat, feature.geometry),
    );

  const spatialMatchCount = matches.length;
  let value: string | null = null;
  let matchedFeatureIndex: number | null = null;
  let selectionReason: string;
  let unresolvedKeys: string[] | undefined;
  let unresolvedKeyValues: Record<string, string | number | boolean | null> | undefined;

  if (spatialMatchCount === 0) {
    selectionReason =
      returnedFeatureCount === 0 ? "no features returned" : "no spatial match";

  } else if (spatialMatchCount === 1) {
    matchedFeatureIndex = matches[0].index;
    value = extractRaw(matches[0].feature.properties);
    if (value !== null) {
      selectionReason = "unique spatial match";
    } else {
      selectionReason = "explicit value not resolved";
      const props = matches[0].feature.properties ?? {};
      // キー一覧と実値を両方記録。DB から候補キー追加の判断に使う。
      unresolvedKeys = Object.keys(props);
      unresolvedKeyValues = toPrimitiveProps(props);
    }

  } else {
    // 複数候補: 全候補の意味値が非 null かつ同一のみ採用
    const values = matches.map((m) => extractRaw(m.feature.properties));
    const allNonNull = values.every((v) => v !== null);
    const allSame = allNonNull && values.every((v) => v === values[0]);

    if (allSame) {
      const sorted = matches.slice().sort((a, b) => {
        const aArea = a.feature.geometry ? geometryApproxArea(a.feature.geometry) : Infinity;
        const bArea = b.feature.geometry ? geometryApproxArea(b.feature.geometry) : Infinity;
        return aArea - bArea;
      });
      matchedFeatureIndex = sorted[0].index;
      value = values[0]!;
      selectionReason = "multiple matches, same value";
    } else {
      selectionReason = allNonNull
        ? "conflicting candidates"
        : "insufficient candidate attributes";
    }
  }

  // 条件スプレッドを避け、明示的代入で optional フィールドをセットする。
  // ...(cond && { key }) パターンはコンパイラ最適化で落ちる可能性があるため使わない。
  const meta: EndpointSpatialMeta = {
    returnedFeatureCount,
    spatialMatchCount,
    matchedFeatureIndex,
    selectionReason,
  };
  if (unresolvedKeys !== undefined)      meta.unresolvedKeys      = unresolvedKeys;
  if (unresolvedKeyValues !== undefined) meta.unresolvedKeyValues = unresolvedKeyValues;

  return { value, meta };
}

// ── XKT002 用途地域判定（テスト可能な純粋関数として export）──────────────────────

/**
 * XKT002 (用途地域) FeatureCollection を受け取り、点 (lng, lat) を含む
 * polygon から用途地域・建蔽率・容積率を安全に抽出する。
 *
 * ── 保存条件（安全側優先）───────────────────────────────────────────────────────
 *   空間一致 1 件:
 *     → 属性があれば保存。欠損項目は null のまま。
 *   空間一致 複数件:
 *     → use_area_ja / BCR / FAR が全候補で完全一致する場合のみ保存。
 *       いずれか 1 つでも欠損 or 食い違いがあれば保存しない。
 *   空間一致 0 件 / features 空:
 *     → 保存しない。
 *
 * ── selectionReason の意味 ────────────────────────────────────────────────────
 *   "unique spatial match"               — 1 件一致、採用
 *   "multiple matches but same zoning values" — 複数一致・全値同一、採用
 *   "no spatial match"                   — features はあるが点を含まない
 *   "no features returned"               — features 空（指定なし地域）
 *   "conflicting zoning candidates"      — 複数一致・用途地域が異なる
 *   "conflicting ratio candidates"       — 複数一致・BCR または FAR が異なる
 *   "insufficient candidate attributes"  — 複数一致・属性欠損で比較不能
 *
 * @internal exported for unit tests
 */
export function parseZoningFC(
  fc: GeoJsonFC,
  lng: number,
  lat: number,
): { data: InvestigationResult; meta: ZoningMeta } {
  const features = fc.features ?? [];
  const returnedFeatureCount = features.length;

  // 1. 空間フィルタ: 点を含む feature のみ
  const spatialMatches = features
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) =>
      feature.geometry != null && pointInGeometry(lng, lat, feature.geometry),
    );

  const spatialMatchCount = spatialMatches.length;
  const matchedFeatureIndexes = spatialMatches.map((m) => m.index);

  // 2. candidateSummaries を生成（全候補を監査用に保存）
  const candidateSummaries: ZoningCandidateInfo[] = spatialMatches.map(
    ({ feature, index }) => ({
      featureIndex: index,
      useAreaJa: pickStr(feature.properties, ["use_area_ja"]),
      buildingCoverageRatioJa: pickStr(feature.properties, [
        "u_building_coverage_ratio_ja", "kenpei", "kenpei_ritsu",
      ]),
      floorAreaRatioJa: pickStr(feature.properties, [
        "u_floor_area_ratio_ja", "yoseki", "yoseki_ritsu",
      ]),
      geometryType: feature.geometry?.type ?? "unknown",
      approxArea: feature.geometry ? geometryApproxArea(feature.geometry) : Infinity,
    }),
  );

  // 3. 選択ロジック
  const data: InvestigationResult = {};
  let selectedUseAreaJa: string | null = null;
  let selectedBuildingCoverageRatio: number | null = null;
  let selectedFloorAreaRatio: number | null = null;
  let selectionReason: string;

  /** 採用した properties から data / selected* を埋める。 */
  const commit = (props: Record<string, unknown>): void => {
    const zoneRaw = pickStr(props, ["use_area_ja", "youto", "youto_cd"]);
    if (zoneRaw !== null) {
      selectedUseAreaJa = zoneRaw;
      data.zoningDistrict = ZONE_LABELS[zoneRaw.trim()] ?? zoneRaw.trim();
    }
    const bcrRaw = pickStr(props, ["u_building_coverage_ratio_ja", "kenpei", "kenpei_ritsu"]);
    if (bcrRaw !== null) {
      const n = parseRatioPercent(bcrRaw);
      if (n !== null && n > 0) { selectedBuildingCoverageRatio = n; data.buildingCoverageRatio = n; }
    }
    const farRaw = pickStr(props, ["u_floor_area_ratio_ja", "yoseki", "yoseki_ritsu"]);
    if (farRaw !== null) {
      const n = parseRatioPercent(farRaw);
      if (n !== null && n > 0) { selectedFloorAreaRatio = n; data.floorAreaRatio = n; }
    }
  };

  if (spatialMatchCount === 0) {
    selectionReason =
      returnedFeatureCount === 0 ? "no features returned" : "no spatial match";

  } else if (spatialMatchCount === 1) {
    selectionReason = "unique spatial match";
    commit(spatialMatches[0].feature.properties);

  } else {
    // 複数候補 — 全フィールドが全候補で完全一致する場合のみ採用。
    // null が混在する場合も「比較不能」として保存しない。
    const zones = candidateSummaries.map((c) => c.useAreaJa);
    const bcrs  = candidateSummaries.map((c) => c.buildingCoverageRatioJa);
    const fars  = candidateSummaries.map((c) => c.floorAreaRatioJa);

    /**
     * 全値が非 null かつ全て同一なら true。
     * null 混在・null 一致・値不一致はすべて false。
     */
    const allSameNonNull = (vals: (string | null)[]): boolean =>
      vals.every((v) => v !== null) && vals.every((v) => v === vals[0]);

    /**
     * conflict / insufficient を区別する reason を返す。
     * - 全て非 null だが異なる値 → "conflicting {label} candidates"
     * - それ以外（null 混在、全 null）→ "insufficient candidate attributes"
     */
    const conflictReason = (vals: (string | null)[], label: string): string =>
      vals.every((v) => v !== null) ? `conflicting ${label} candidates` : "insufficient candidate attributes";

    if (!allSameNonNull(zones)) {
      selectionReason = conflictReason(zones, "zoning");
    } else if (!allSameNonNull(bcrs)) {
      selectionReason = conflictReason(bcrs, "ratio");
    } else if (!allSameNonNull(fars)) {
      selectionReason = conflictReason(fars, "ratio");
    } else {
      // 全フィールド一致 → 最小面積の候補を採用
      const best = candidateSummaries.slice().sort((a, b) => a.approxArea - b.approxArea)[0];
      const bestFeature = spatialMatches.find((m) => m.index === best.featureIndex)!;
      selectionReason = "multiple matches but same zoning values";
      commit(bestFeature.feature.properties);
    }
  }

  return {
    data,
    meta: {
      returnedFeatureCount,
      spatialMatchCount,
      candidateSummaries,
      matchedFeatureIndexes,
      selectedUseAreaJa,
      selectedBuildingCoverageRatio,
      selectedFloorAreaRatio,
      selectionReason,
    },
  };
}

// ── XKT014/025~030 endpoint 純粋関数（export・ユニットテスト可能）────────────────

/**
 * XKT014 (防火・準防火地域) → firePreventionZone
 *
 * 公式確認済み属性名:
 *   fire_prevention_ja : 防火地域区分（日本語ラベル）← 最優先
 *   kubun_id           : 区分 ID (1=防火 / 2=準防火 / 3=法22条) コード値
 *
 * kubun_id=0 / 空文字 は「防火地域指定なし」を表すため null 扱いにして保存しない。
 *
 * @internal exported for unit tests
 */
export function parseFireZoneFC(
  fc: GeoJsonFC,
  lng: number,
  lat: number,
): { data: InvestigationResult; meta: EndpointSpatialMeta } {
  const { value, meta } = resolveByPoint(fc, lng, lat, (props) => {
    const raw = pickStr(props, ["fire_prevention_ja", "kubun_id"]);
    if (raw === null || raw === "0" || raw === "") return null; // 指定なし
    return FIRE_LABELS[raw] ?? raw;
  });
  return { data: value !== null ? { firePreventionZone: value } : {}, meta };
}

/**
 * XKT025 (液状化危険度) → liquefactionRiskLevel
 *
 * 属性名未確定のため複数候補を順に試す。
 * 属性が取得できなかった場合は保存しない（null）。
 * 属性が取得できた場合のみ、その明示的な値を保存する。
 *
 * @internal exported for unit tests
 */
export function parseLiquefactionFC(
  fc: GeoJsonFC,
  lng: number,
  lat: number,
): { data: InvestigationResult; meta: EndpointSpatialMeta } {
  const { value, meta } = resolveByPoint(fc, lng, lat, (props) =>
    pickStr(props, [
      // 確認済み候補（公式仕様書 / 実 API ログ由来）
      "rank_ja", "rank", "class_ja", "class",
      "ekijoka_rank", "liquefaction_rank",
      // 実観測キー (2026-04-21): unresolvedKeys で確認
      "liquefaction_tendency_level",
      // 拡張候補 A: API 応答キー名の揺れに対応
      "liq_rank_ja", "liq_class", "liq_rank", "liq_kubun", "liq_risk",
      "level", "level_ja", "risk_level", "risk_level_ja",
      "category", "category_ja",
      "area_type", "susceptibility",
      // 拡張候補 B: 国土数値情報形式コード (A30a 液状化危険地盤)
      "A30a_001", "A30a_002",
      // 拡張候補 C: 日本語属性名
      "危険度区分", "区分", "液状化危険度区分",
      // 拡張候補 D: その他パターン
      "description", "name", "hazard_class",
    ]),
  );
  if (meta.selectionReason === "explicit value not resolved") {
    // resolveByPoint 経由の代入が本番ビルドで落ちる可能性を排除するため
    // fc を直接参照して unresolvedKeyValues を再代入する（belt-and-suspenders）。
    if (meta.matchedFeatureIndex !== null) {
      const props = (fc.features ?? [])[meta.matchedFeatureIndex]?.properties ?? {};
      meta.unresolvedKeyValues = toPrimitiveProps(props);
    }
    console.error(
      `[reinfolib] XKT025(液状化) 属性未解決` +
      ` | idx=${meta.matchedFeatureIndex}` +
      ` | keys=[${(meta.unresolvedKeys ?? []).join(",")}]` +
      ` | values=${JSON.stringify(meta.unresolvedKeyValues ?? {})}`,
    );
  }
  return { data: value !== null ? { liquefactionRiskLevel: value } : {}, meta };
}

/**
 * XKT026 (洪水浸水想定区域) → floodRiskLevel
 * 属性名未確定のため複数候補を順に試す。属性不明なら保存しない。
 *
 * @internal exported for unit tests
 */
export function parseFloodFC(
  fc: GeoJsonFC,
  lng: number,
  lat: number,
): { data: InvestigationResult; meta: EndpointSpatialMeta } {
  const { value, meta } = resolveByPoint(fc, lng, lat, (props) =>
    pickStr(props, [
      // 確認済み候補（公式仕様書 / 実 API ログ由来）
      "scale", "shinsui_scale", "depth_scale",
      "class_ja", "rank_ja",
      // 拡張候補 A: API 応答キー名の揺れに対応
      "depth", "depth_ja", "depth_m", "depth_rank",
      "type", "type_ja",
      "kubun", "kubun_ja",
      "area_class", "flood_rank", "flood_depth",
      "shinsui_class", "inundation_depth",
      // 実観測キー (2026-04-21): unresolvedKeys で確認 (A31a 洪水浸水想定区域)
      "A31a_201", "A31a_202", "A31a_203", "A31a_204", "A31a_205",
      // 拡張候補 B: 国土数値情報形式コード (A31 洪水浸水想定区域)
      "A31_001", "A31_002",
      // 拡張候補 C: 日本語属性名
      "浸水深区分", "浸水ランク", "浸水想定深",
      // 拡張候補 D: その他パターン
      "description", "name", "flood_class", "shinsui_depth",
    ]),
  );
  if (meta.selectionReason === "explicit value not resolved") {
    if (meta.matchedFeatureIndex !== null) {
      const props = (fc.features ?? [])[meta.matchedFeatureIndex]?.properties ?? {};
      meta.unresolvedKeyValues = toPrimitiveProps(props);
    }
    console.error(
      `[reinfolib] XKT026(洪水) 属性未解決` +
      ` | idx=${meta.matchedFeatureIndex}` +
      ` | keys=[${(meta.unresolvedKeys ?? []).join(",")}]` +
      ` | values=${JSON.stringify(meta.unresolvedKeyValues ?? {})}`,
    );
  }
  return { data: value !== null ? { floodRiskLevel: value } : {}, meta };
}

/**
 * XKT027 (高潮浸水想定区域) → stormSurgeRiskLevel
 * 属性不明なら保存しない。
 *
 * @internal exported for unit tests
 */
export function parseStormSurgeFC(
  fc: GeoJsonFC,
  lng: number,
  lat: number,
): { data: InvestigationResult; meta: EndpointSpatialMeta } {
  const { value, meta } = resolveByPoint(fc, lng, lat, (props) =>
    pickStr(props, [
      "scale", "depth_scale", "takashio_scale",
      "class_ja", "rank_ja",
    ]),
  );
  return { data: value !== null ? { stormSurgeRiskLevel: value } : {}, meta };
}

/**
 * XKT028 (津波浸水想定区域) → tsunamiRiskLevel
 * 属性不明なら保存しない。
 *
 * @internal exported for unit tests
 */
export function parseTsunamiFC(
  fc: GeoJsonFC,
  lng: number,
  lat: number,
): { data: InvestigationResult; meta: EndpointSpatialMeta } {
  const { value, meta } = resolveByPoint(fc, lng, lat, (props) =>
    pickStr(props, [
      "scale", "depth_scale", "tsunami_scale",
      "class_ja", "rank_ja",
    ]),
  );
  return { data: value !== null ? { tsunamiRiskLevel: value } : {}, meta };
}

/**
 * XKT029 (土砂災害警戒区域) → sedimentRiskCategory
 *
 * kubun_id: 1=土砂災害警戒区域 / 2=土砂災害特別警戒区域
 * 属性が取れない場合は null を返して保存しない。
 * ※ XKT016 は「災害危険区域」であり土砂災害警戒区域ではない。使用しないこと。
 *
 * @internal exported for unit tests
 */
export function parseSedimentFC(
  fc: GeoJsonFC,
  lng: number,
  lat: number,
): { data: InvestigationResult; meta: EndpointSpatialMeta } {
  const { value, meta } = resolveByPoint(fc, lng, lat, (props) => {
    const raw = pickStr(props, [
      "kubun_ja", "kubun_id", "category_ja", "type_ja",
      "saigai_kubun", "dosya_kubun",
    ]);
    if (raw === null) return null; // 属性不明 → 保存しない
    if (raw === "1") return "土砂災害警戒区域";
    if (raw === "2") return "土砂災害特別警戒区域";
    return raw;
  });
  return { data: value !== null ? { sedimentRiskCategory: value } : {}, meta };
}

/**
 * XKT030 (道路情報) → roadType / roadWidth
 *
 * roadType と roadWidth は独立した属性として扱う。
 * 複数候補が競合する場合は属性ごとに独立して保存可否を判定し、
 * 競合する属性のみ保存しない（一方が一致していれば保存する）。
 *
 * @internal exported for unit tests
 */
export function parseRoadFC(
  fc: GeoJsonFC,
  lng: number,
  lat: number,
): { data: InvestigationResult; meta: EndpointSpatialMeta } {
  const features = fc.features ?? [];
  const returnedFeatureCount = features.length;

  const matches = features
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) =>
      feature.geometry != null && pointInGeometry(lng, lat, feature.geometry),
    );

  const spatialMatchCount = matches.length;
  const data: InvestigationResult = {};
  let matchedFeatureIndex: number | null = null;
  let selectionReason: string;

  if (spatialMatchCount === 0) {
    selectionReason =
      returnedFeatureCount === 0 ? "no features returned" : "no spatial match";

  } else if (spatialMatchCount === 1) {
    const { feature, index } = matches[0];
    matchedFeatureIndex = index;
    const props = feature.properties;
    const typeRaw = pickStr(props, [
      "road_type_ja", "road_type", "douro_kubun_ja", "douro_kubun",
    ]);
    if (typeRaw !== null) data.roadType = typeRaw;
    const widthRaw = pickStr(props, ["width_m", "road_width", "douro_width", "width"]);
    if (widthRaw !== null) {
      const n = Number(widthRaw);
      if (!isNaN(n) && n > 0) data.roadWidth = n;
    }
    selectionReason = "unique spatial match";

  } else {
    // 複数候補: 属性ごとに独立してチェック
    const types = matches.map((m) =>
      pickStr(m.feature.properties, [
        "road_type_ja", "road_type", "douro_kubun_ja", "douro_kubun",
      ]),
    );
    const widthStrs = matches.map((m) => {
      const raw = pickStr(m.feature.properties, [
        "width_m", "road_width", "douro_width", "width",
      ]);
      if (raw === null) return null;
      const n = Number(raw);
      return isNaN(n) || n <= 0 ? null : String(n);
    });

    const typeOk =
      types.every((t) => t !== null) && types.every((t) => t === types[0]);
    const widthOk =
      widthStrs.every((w) => w !== null) && widthStrs.every((w) => w === widthStrs[0]);

    // 最小面積を matchedFeatureIndex として記録
    const sorted = matches.slice().sort((a, b) => {
      const aArea = a.feature.geometry ? geometryApproxArea(a.feature.geometry) : Infinity;
      const bArea = b.feature.geometry ? geometryApproxArea(b.feature.geometry) : Infinity;
      return aArea - bArea;
    });
    matchedFeatureIndex = sorted[0].index;

    // 一致している属性だけ保存（「誤値を保存しない」原則を属性単位で適用）
    if (typeOk)  data.roadType  = types[0]!;
    if (widthOk) {
      const n = Number(widthStrs[0]);
      if (!isNaN(n) && n > 0) data.roadWidth = n;
    }

    if (typeOk && widthOk) {
      selectionReason = "multiple matches, same value";
    } else if (typeOk) {
      selectionReason = "multiple matches, road width conflicted (type saved)";
    } else if (widthOk) {
      selectionReason = "multiple matches, road type conflicted (width saved)";
    } else {
      selectionReason =
        types.every((t) => t !== null) && widthStrs.every((w) => w !== null)
          ? "conflicting candidates"
          : "insufficient candidate attributes";
    }
  }

  return {
    data,
    meta: { returnedFeatureCount, spatialMatchCount, matchedFeatureIndex, selectionReason },
  };
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
    //    HTTP 4xx は恒久失敗（throw）。HTTP 5xx / ネットワーク失敗は MAX_TILE_RETRIES 回リトライ後に throw。
    const EMPTY: GeoJsonFC = { type: "FeatureCollection", features: [] };
    const tileErrors: string[] = [];
    const tileRetries: Record<string, number> = {};

    const tryCall = async (ep: string): Promise<GeoJsonFC> => {
      try {
        const { fc, attempts } = await this.callTileApi(ep, x, y);
        if (attempts > 1) tileRetries[ep] = attempts;
        return fc;
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

    // 3. 各 endpoint を空間フィルタ付きで解析
    const zoningParsed      = parseZoningFC(zoningResult,       lng, lat);
    const fireParsed        = parseFireZoneFC(fireResult,       lng, lat);
    const liquefactionParsed = parseLiquefactionFC(liquefactionResult, lng, lat);
    const floodParsed       = parseFloodFC(floodResult,         lng, lat);
    const stormParsed       = parseStormSurgeFC(stormResult,    lng, lat);
    const tsunamiParsed     = parseTsunamiFC(tsunamiResult,     lng, lat);
    const sedimentParsed    = parseSedimentFC(sedimentResult,   lng, lat);
    const roadParsed        = parseRoadFC(roadResult,           lng, lat);

    const data: InvestigationResult = {
      ...zoningParsed.data,
      ...fireParsed.data,
      ...liquefactionParsed.data,
      ...floodParsed.data,
      ...stormParsed.data,
      ...tsunamiParsed.data,
      ...sedimentParsed.data,
      ...roadParsed.data,
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
        zoning:       zoningParsed.meta,
        firezone:     fireParsed.meta,
        liquefaction: liquefactionParsed.meta,
        flood:        floodParsed.meta,
        stormSurge:   stormParsed.meta,
        tsunami:      tsunamiParsed.meta,
        sediment:     sedimentParsed.meta,
        road:         roadParsed.meta,
        emptyEndpoints,
        ...(tileErrors.length > 0 && { tileErrors }),
        ...(Object.keys(tileRetries).length > 0 && { tileRetries }),
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
   * REINFOLIB タイル API を呼び出す。失敗時は attempt 引数でリトライを管理する。
   *
   * URL 形式（公式マニュアル準拠）:
   *   GET {BASE}/{endpoint}?response_format=geojson&z={z}&x={x}&y={y}
   *   z/x/y はクエリパラメータ（パスセグメントではない）。
   *
   * リトライ戦略:
   *   - 一時失敗（ネットワーク/タイムアウト/HTTP 5xx）: 最大 MAX_TILE_RETRIES 回リトライ。
   *     バックオフ: 1秒 × attempt 番号（1回目なら1秒待ち、2回目なら2秒待ち）。
   *   - 恒久失敗（HTTP 4xx）: リトライなし、即 throw。
   *
   * @returns { fc, attempts } fc = GeoJSONFC, attempts = 実際の試行回数
   */
  private async callTileApi(
    endpoint: string,
    x: number,
    y: number,
    attempt = 1,
  ): Promise<{ fc: GeoJsonFC; attempts: number }> {
    const url =
      `${REINFOLIB_BASE}/${endpoint}` +
      `?response_format=geojson&z=${ZOOM}&x=${x}&y=${y}`;

    if (attempt === 1) {
      console.debug(`[reinfolib] ${endpoint} z=${ZOOM} x=${x} y=${y} → ${url}`);
    } else {
      console.warn(`[reinfolib] ${endpoint} retry attempt=${attempt} z=${ZOOM} x=${x} y=${y}`);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // ネットワーク失敗 / タイムアウト → 一時失敗
      if (attempt <= MAX_TILE_RETRIES) {
        console.warn(
          `[reinfolib] ${endpoint} 一時失敗（ネットワーク/タイムアウト）attempt=${attempt}: ${String(err)}`,
        );
        await sleep(1_000 * attempt);
        return this.callTileApi(endpoint, x, y, attempt + 1);
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");

      // 4xx → 恒久失敗（URL形式 / 認証エラー）、リトライしない
      if (res.status < 500) {
        console.error(
          `[reinfolib] ${endpoint} HTTP ${res.status} (恒久失敗) | URL: ${url} | body: ${body.slice(0, 500)}`,
        );
        throw new Error(
          `不動産情報ライブラリ ${endpoint} エラー: HTTP ${res.status} ${res.statusText}` +
            (body ? ` — ${body.slice(0, 200)}` : ""),
        );
      }

      // 5xx → 一時失敗、リトライ対象
      if (attempt <= MAX_TILE_RETRIES) {
        console.warn(
          `[reinfolib] ${endpoint} HTTP ${res.status} (一時失敗) attempt=${attempt}, retrying...`,
        );
        await sleep(1_000 * attempt);
        return this.callTileApi(endpoint, x, y, attempt + 1);
      }

      console.error(
        `[reinfolib] ${endpoint} HTTP ${res.status} (${attempt}回試行後) | URL: ${url} | body: ${body.slice(0, 500)}`,
      );
      throw new Error(
        `不動産情報ライブラリ ${endpoint} エラー: HTTP ${res.status} ${res.statusText}` +
          (body ? ` — ${body.slice(0, 200)}` : ""),
      );
    }

    const fc = await res.json() as GeoJsonFC;
    console.debug(
      `[reinfolib] ${endpoint} HTTP ${res.status} | attempt=${attempt} | features: ${(fc.features ?? []).length}`,
    );
    return { fc, attempts: attempt };
  }
}

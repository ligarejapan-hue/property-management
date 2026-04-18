/**
 * Investigation Provider Abstraction
 *
 * Defines the interface for external data sources used to enrich property
 * information (zoning, building coverage, road info, route price, etc.).
 *
 * To add a new data source:
 *   1. Implement InvestigationProvider
 *   2. Register it in ./index.ts
 *   3. The investigation API route will call all registered providers
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Fields that an investigation provider may return. */
export interface InvestigationResult {
  // 用途地域 / Zoning
  zoningDistrict?: string;

  // 建蔽率 / Building coverage ratio (%)
  buildingCoverageRatio?: number;

  // 容積率 / Floor area ratio (%)
  floorAreaRatio?: number;

  // 高度地区
  heightDistrict?: string;

  // 防火地域
  firePreventionZone?: string;

  // ハザード詳細（reinfolib XKT025/016/026/027）
  // features 空配列 = 指定なし。存在する場合は深さスケールや区分を格納する。
  floodRiskLevel?: string;       // XKT025 洪水浸水想定区域
  sedimentRiskCategory?: string; // XKT016 土砂災害警戒区域
  tsunamiRiskLevel?: string;     // XKT026 津波浸水想定区域
  stormSurgeRiskLevel?: string;  // XKT027 高潮浸水想定区域

  // 景観規制
  scenicRestriction?: string;

  // 道路種別 (公道 / 私道 / 位置指定道路 etc.)
  roadType?: string;

  // 道路幅員 (m)
  roadWidth?: number;

  // 間口幅 (m)
  frontageWidth?: number;

  // 間口方角
  frontageDirection?: string;

  // セットバック
  setbackRequired?: "yes" | "no" | "unknown";

  // 路線価 (円/m²)
  rosenkaValue?: number;

  // 路線価年度
  rosenkaYear?: number;

  // 再建築許可
  rebuildPermission?: "yes" | "no" | "needs_review";

  // 建築備考
  architectureNote?: string;
}

/** Property context passed to the provider so it can look up data. */
export interface InvestigationQuery {
  propertyId: string;
  address: string;
  lotNumber?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  /** Optional year for route-price lookups. */
  targetYear?: number;
}

/** Result returned by a single provider. */
export interface ProviderResponse {
  /** Provider identifier (e.g. "国土数値情報API", "路線価API") */
  source: string;
  /** Fetched data. Only include fields that were actually resolved. */
  data: InvestigationResult;
  /** Provider-specific metadata (response ID, cache key, etc.). */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * An InvestigationProvider knows how to fetch one or more investigation fields
 * from an external (or internal) data source.
 *
 * Each provider is responsible for a logical group of fields.  The
 * investigation orchestrator calls all registered providers in parallel and
 * merges their results.
 */
export interface InvestigationProvider {
  /** Unique identifier shown in logs and UI. */
  readonly name: string;

  /**
   * Human-readable description of what this provider fetches.
   * Used in admin/debug UIs and reports.
   */
  readonly description: string;

  /**
   * List of InvestigationResult keys this provider is able to populate.
   * Used by the orchestrator to detect overlapping providers.
   */
  readonly fields: readonly (keyof InvestigationResult)[];

  /**
   * Fetch investigation data for the given property.
   *
   * @returns ProviderResponse with resolved data, or throws on hard failure.
   * Providers should return partial data rather than throw when some fields
   * could not be resolved.
   */
  fetch(query: InvestigationQuery): Promise<ProviderResponse>;

  /**
   * Optional health-check.  Return true if the upstream is reachable.
   * Used by monitoring / admin dashboards.
   */
  healthCheck?(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Merged result (returned by the orchestrator)
// ---------------------------------------------------------------------------

export interface MergedInvestigationResult {
  /** Overall status. */
  status: "success" | "partial" | "failed";
  /** Merged data from all providers (last-write-wins for overlapping keys). */
  data: InvestigationResult;
  /** Per-provider details. */
  providers: {
    name: string;
    status: "success" | "failed";
    source: string;
    fields: string[];
    error?: string;
    meta?: Record<string, unknown>;
  }[];
  /** ISO timestamp. */
  fetchedAt: string;
}

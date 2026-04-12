/**
 * Investigation Orchestrator
 *
 * Manages a registry of InvestigationProviders and executes them in parallel,
 * merging results into a single InvestigationResult.
 *
 * --- Adding a new provider ---
 *
 * 1. Create a class that implements InvestigationProvider (see stub-provider.ts).
 * 2. Import and register it in getProviders() below.
 * 3. The orchestrator will automatically call it alongside existing providers.
 *
 * --- Provider priority ---
 *
 * If multiple providers populate the same field, the last registered provider
 * wins (providers array order matters).  Put higher-priority / more-accurate
 * providers at the end of the list.
 *
 * --- Environment-based switching ---
 *
 * Use env vars to toggle providers:
 *   INVESTIGATION_ZONING_PROVIDER=stub|ksj       (国土数値情報)
 *   INVESTIGATION_ROSЕНКА_PROVIDER=stub|nta       (国税庁路線価)
 *   INVESTIGATION_ROAD_PROVIDER=stub|road-ledger  (道路台帳)
 */

import type {
  InvestigationProvider,
  InvestigationQuery,
  InvestigationResult,
  MergedInvestigationResult,
} from "./types";
import { StubProvider } from "./stub-provider";
import { KsjZoningProvider } from "./ksj-zoning-provider";

// Re-export types for convenience
export type {
  InvestigationProvider,
  InvestigationQuery,
  InvestigationResult,
  MergedInvestigationResult,
  ProviderResponse,
} from "./types";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

let _providers: InvestigationProvider[] | null = null;

/**
 * Returns the list of active investigation providers.
 *
 * To add a real provider (e.g. KsjZoningProvider):
 * ```ts
 * import { KsjZoningProvider } from "./ksj-zoning-provider";
 * providers.push(new KsjZoningProvider());
 * ```
 */
function getProviders(): InvestigationProvider[] {
  if (_providers) return _providers;

  const providers: InvestigationProvider[] = [];

  // --- Stub provider (always active as fallback) ---
  providers.push(new StubProvider());

  // --- 実プロバイダ (env が設定されていれば自動有効) ---

  // 用途地域・建蔽率・容積率・防火地域 (国土数値情報 A29)
  if (process.env.KSJ_API_URL) {
    providers.push(new KsjZoningProvider());
  }
  //
  // 路線価 (国税庁):
  //   import { NtaRosenkaProvider } from "./nta-rosenka-provider";
  //   if (process.env.NTA_ROSENKA_API_URL) providers.push(new NtaRosenkaProvider());
  //
  // 道路台帳:
  //   import { RoadLedgerProvider } from "./road-ledger-provider";
  //   if (process.env.ROAD_LEDGER_API_URL) providers.push(new RoadLedgerProvider());

  _providers = providers;
  return _providers;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all registered investigation providers in parallel and merge results.
 */
export async function runInvestigation(
  query: InvestigationQuery,
): Promise<MergedInvestigationResult> {
  const providers = getProviders();
  const fetchedAt = new Date().toISOString();

  // Run all providers concurrently
  const settled = await Promise.allSettled(
    providers.map(async (p) => {
      const res = await p.fetch(query);
      return { provider: p, response: res };
    }),
  );

  // Merge results
  const mergedData: InvestigationResult = {};
  const providerDetails: MergedInvestigationResult["providers"] = [];
  let hasSuccess = false;
  let hasFailure = false;

  for (const result of settled) {
    if (result.status === "fulfilled") {
      const { provider, response } = result.value;
      // Merge data (last-write-wins)
      Object.assign(mergedData, response.data);
      providerDetails.push({
        name: provider.name,
        status: "success",
        source: response.source,
        fields: Object.keys(response.data),
        meta: response.meta,
      });
      hasSuccess = true;
    } else {
      // Find which provider failed (by index)
      const idx = settled.indexOf(result);
      const provider = providers[idx];
      providerDetails.push({
        name: provider.name,
        status: "failed",
        source: "",
        fields: [],
        error: result.reason?.message ?? "Unknown error",
      });
      hasFailure = true;
    }
  }

  let status: MergedInvestigationResult["status"];
  if (!hasSuccess) {
    status = "failed";
  } else if (hasFailure) {
    status = "partial";
  } else {
    status = "success";
  }

  return {
    status,
    data: mergedData,
    providers: providerDetails,
    fetchedAt,
  };
}

/**
 * List all registered providers (for admin/debug endpoints).
 */
export function listProviders(): {
  name: string;
  description: string;
  fields: string[];
}[] {
  return getProviders().map((p) => ({
    name: p.name,
    description: p.description,
    fields: [...p.fields],
  }));
}

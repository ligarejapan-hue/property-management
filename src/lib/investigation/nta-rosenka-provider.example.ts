/**
 * Example: NTA (国税庁) Route Price Provider
 *
 * This is a TEMPLATE for implementing a real provider that fetches route
 * price (路線価) data from the National Tax Agency open data.
 *
 * Data sources:
 *   - 国税庁 路線価図・評価倍率表
 *     https://www.rosenka.nta.go.jp/
 *   - 全国地価マップ
 *     https://www.chikamap.jp/
 *
 * Required env vars:
 *   NTA_ROSENKA_API_URL=<your-api-endpoint>
 *   NTA_ROSENKA_API_KEY=<optional-api-key>
 *
 * To activate:
 *   1. Copy to nta-rosenka-provider.ts
 *   2. Set env vars
 *   3. Register in index.ts getProviders()
 */

import type {
  InvestigationProvider,
  InvestigationQuery,
  ProviderResponse,
  InvestigationResult,
} from "./types";

export class NtaRosenkaProvider implements InvestigationProvider {
  readonly name = "nta-rosenka";
  readonly description = "国税庁路線価APIから路線価・路線価年度を取得";
  readonly fields: (keyof InvestigationResult)[] = [
    "rosenkaValue",
    "rosenkaYear",
  ];

  private apiUrl: string;

  constructor() {
    this.apiUrl = process.env.NTA_ROSENKA_API_URL ?? "";
    if (!this.apiUrl) {
      throw new Error("NTA_ROSENKA_API_URL is not configured");
    }
  }

  async fetch(query: InvestigationQuery): Promise<ProviderResponse> {
    // Implementation steps:
    //
    // 1. Determine target year (default: current year - 1)
    //    const year = query.targetYear ?? new Date().getFullYear() - 1;
    //
    // 2. Look up route price by address or coordinates
    //    const res = await fetch(`${this.apiUrl}/rosenka`, {
    //      method: "POST",
    //      headers: {
    //        "Content-Type": "application/json",
    //        "X-API-Key": process.env.NTA_ROSENKA_API_KEY ?? "",
    //      },
    //      body: JSON.stringify({
    //        address: query.address,
    //        lotNumber: query.lotNumber,
    //        lat: query.gpsLat,
    //        lng: query.gpsLng,
    //        year,
    //      }),
    //    });
    //
    // 3. Parse response
    //    const data = await res.json();
    //
    // 4. Return result
    //    return {
    //      source: "国税庁路線価",
    //      data: {
    //        rosenkaValue: data.routePrice, // 円/m²
    //        rosenkaYear: data.year,
    //      },
    //      meta: {
    //        routeId: data.routeId,
    //        symbol: data.symbol, // e.g. "200D" (千円/m², D=借地権割合)
    //      },
    //    };

    throw new Error(
      `NtaRosenkaProvider is a template – implement fetch(). Query: ${query.address}`,
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(this.apiUrl, { method: "HEAD" });
      return res.ok;
    } catch {
      return false;
    }
  }
}

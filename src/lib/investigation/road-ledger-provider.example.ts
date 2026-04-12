/**
 * Example: Road Ledger (道路台帳) Provider
 *
 * This is a TEMPLATE for implementing a real provider that fetches road
 * information from municipal road ledger data or related APIs.
 *
 * Data sources:
 *   - 各自治体の道路台帳閲覧サービス
 *   - 国土交通省 道路情報提供システム
 *
 * Required env vars:
 *   ROAD_LEDGER_API_URL=<your-api-endpoint>
 *   ROAD_LEDGER_API_KEY=<optional-api-key>
 *
 * To activate:
 *   1. Copy to road-ledger-provider.ts
 *   2. Set env vars
 *   3. Register in index.ts getProviders()
 */

import type {
  InvestigationProvider,
  InvestigationQuery,
  ProviderResponse,
  InvestigationResult,
} from "./types";

export class RoadLedgerProvider implements InvestigationProvider {
  readonly name = "road-ledger";
  readonly description =
    "道路台帳APIから道路種別・道路幅員・間口・セットバック情報を取得";
  readonly fields: (keyof InvestigationResult)[] = [
    "roadType",
    "roadWidth",
    "frontageWidth",
    "frontageDirection",
    "setbackRequired",
  ];

  private apiUrl: string;

  constructor() {
    this.apiUrl = process.env.ROAD_LEDGER_API_URL ?? "";
    if (!this.apiUrl) {
      throw new Error("ROAD_LEDGER_API_URL is not configured");
    }
  }

  async fetch(query: InvestigationQuery): Promise<ProviderResponse> {
    // Implementation steps:
    //
    // 1. Look up road info by address or coordinates
    //    const res = await fetch(`${this.apiUrl}/road-info`, {
    //      method: "POST",
    //      headers: { "Content-Type": "application/json" },
    //      body: JSON.stringify({
    //        address: query.address,
    //        lat: query.gpsLat,
    //        lng: query.gpsLng,
    //      }),
    //    });
    //
    // 2. Parse response
    //    const data = await res.json();
    //
    // 3. Map road classification to standardized type
    //    const roadTypeMap: Record<string, string> = {
    //      "1": "国道",
    //      "2": "都道府県道",
    //      "3": "市区町村道",
    //      "4": "私道",
    //      "5": "位置指定道路",
    //      "6": "建築基準法43条但書道路",
    //    };
    //
    // 4. Determine setback requirement
    //    const setbackRequired =
    //      data.roadWidth < 4.0 ? "yes" :
    //      data.roadWidth >= 4.0 ? "no" : "unknown";
    //
    // 5. Return result
    //    return {
    //      source: "道路台帳",
    //      data: {
    //        roadType: roadTypeMap[data.classification] ?? data.roadName,
    //        roadWidth: data.roadWidth,      // meters
    //        frontageWidth: data.frontage,    // meters
    //        frontageDirection: data.direction, // "南", "北東" etc.
    //        setbackRequired,
    //      },
    //      meta: {
    //        roadId: data.roadId,
    //        municipality: data.municipality,
    //      },
    //    };

    throw new Error(
      `RoadLedgerProvider is a template – implement fetch(). Query: ${query.address}`,
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

/**
 * Example: KSJ (国土数値情報) Zoning Provider
 *
 * This is a TEMPLATE for implementing a real provider that fetches zoning
 * and building regulation data from the National Land Numerical Information
 * download service (国土数値情報ダウンロードサービス).
 *
 * API Reference:
 *   https://nlftp.mlit.go.jp/ksj/api/about_api.html
 *
 * Data sources covered:
 *   - A29: 用途地域 (Use District / Zoning)
 *   - A22: 防火地域・準防火地域 (Fire Prevention Zone)
 *   - A30: 高度地区 (Height District)
 *
 * Required env vars:
 *   KSJ_API_URL=https://nlftp.mlit.go.jp/ksj/api/1.0b
 *
 * To activate:
 *   1. Copy this file to ksj-zoning-provider.ts (remove .example suffix)
 *   2. Set KSJ_API_URL in .env
 *   3. Register in index.ts getProviders()
 */

import type {
  InvestigationProvider,
  InvestigationQuery,
  ProviderResponse,
  InvestigationResult,
} from "./types";

export class KsjZoningProvider implements InvestigationProvider {
  readonly name = "ksj-zoning";
  readonly description =
    "国土数値情報APIから用途地域・建蔽率・容積率・防火地域を取得";
  readonly fields: (keyof InvestigationResult)[] = [
    "zoningDistrict",
    "buildingCoverageRatio",
    "floorAreaRatio",
    "heightDistrict",
    "firePreventionZone",
  ];

  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.KSJ_API_URL ?? "";
    if (!this.baseUrl) {
      throw new Error("KSJ_API_URL is not configured");
    }
  }

  async fetch(query: InvestigationQuery): Promise<ProviderResponse> {
    // Implementation steps:
    //
    // 1. Geocode the address to lat/lng if not provided
    //    const { lat, lng } = query.gpsLat && query.gpsLng
    //      ? { lat: query.gpsLat, lng: query.gpsLng }
    //      : await geocode(query.address);
    //
    // 2. Call KSJ API to get zoning data for the point
    //    const zoningRes = await fetch(
    //      `${this.baseUrl}/getGML?...&lat=${lat}&lng=${lng}`
    //    );
    //
    // 3. Parse the GML/JSON response
    //    const zoningData = await zoningRes.json();
    //
    // 4. Extract and return relevant fields:
    //    return {
    //      source: "国土数値情報API",
    //      data: {
    //        zoningDistrict: zoningData.useDistrict,
    //        buildingCoverageRatio: zoningData.buildingCoverage,
    //        floorAreaRatio: zoningData.floorAreaRatio,
    //        firePreventionZone: zoningData.firePrevention,
    //        heightDistrict: zoningData.heightDistrict,
    //      },
    //    };

    throw new Error(
      `KsjZoningProvider is a template – implement the fetch() method. Query: ${query.address}`,
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl, { method: "HEAD" });
      return res.ok;
    } catch {
      return false;
    }
  }
}

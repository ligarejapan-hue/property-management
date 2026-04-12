/**
 * Mock KSJ GeoServer (開発・疎通確認用)
 *
 * KsjZoningProvider が期待する GeoServer WFS エンドポイントをエミュレートする。
 * Docker / Java 不要。Node.js のみで起動可能。
 *
 * 対応エンドポイント:
 *   GET /geoserver/ksj/ows?service=WFS&request=GetFeature&typeName=ksj:A29
 *     → GeoJSON FeatureCollection (KSJ A29 属性) を返す
 *   GET /geoserver/ksj/ows?service=WFS&request=GetCapabilities
 *     → 簡易 XML を返す (healthCheck 用)
 *   GET /a29?lat=&lng=
 *     → カスタム REST フォールバック用 (上記と同じ GeoJSON)
 *
 * 使い方:
 *   node scripts/mock-ksj-server.mjs
 *
 * .env に追加:
 *   KSJ_API_URL=http://localhost:9000/geoserver/ksj/ows
 *
 * package.json の scripts に追加済み:
 *   "ksj:mock": "node scripts/mock-ksj-server.mjs"
 */

import http from "http";
import { URL } from "url";

const PORT = process.env.MOCK_KSJ_PORT ?? 9000;

// ---------------------------------------------------------------------------
// サンプルレスポンスデータ (KSJ A29 属性コード準拠)
// 実際の GeoServer はリクエスト座標に対応したポリゴンを返す。
// モックは固定値を返す。
// ---------------------------------------------------------------------------

/**
 * 座標 (lat, lng) に対して返す A29 properties を決定する。
 * 本物に近づけたい場合はここを拡張する。
 */
function resolveZoningProps(lat, lng) {
  // 大まかな緯度経度で地域を簡易判定してサンプル値を返す
  // 東京 23 区内 (35.6〜35.8, 139.6〜139.9)
  if (lat >= 35.6 && lat <= 35.8 && lng >= 139.6 && lng <= 139.9) {
    return {
      A29_001: "13",        // 都道府県コード (東京)
      A29_002: "9",         // 用途地域コード: 近隣商業地域
      A29_003: 80,          // 建蔽率 (%)
      A29_004: 400,         // 容積率 (%)
      A29_005: "第一種高度地区",
      A29_006: 20,          // 高度制限 (m)
      A29_007: "2",         // 防火地域コード: 準防火地域
    };
  }
  // 大阪 (34.6〜34.8, 135.4〜135.6)
  if (lat >= 34.6 && lat <= 34.8 && lng >= 135.4 && lng <= 135.6) {
    return {
      A29_001: "27",
      A29_002: "10",        // 商業地域
      A29_003: 80,
      A29_004: 600,
      A29_005: "指定なし",
      A29_006: 0,
      A29_007: "1",         // 防火地域
    };
  }
  // デフォルト (住宅地を想定)
  return {
    A29_001: "00",
    A29_002: "5",           // 第一種住居地域
    A29_003: 60,
    A29_004: 200,
    A29_005: "第二種高度地区",
    A29_006: 15,
    A29_007: "2",           // 準防火地域
  };
}

function buildGeoJson(props, lat, lng) {
  return {
    type: "FeatureCollection",
    totalFeatures: 1,
    features: [
      {
        type: "Feature",
        id: "A29.mock",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [lng - 0.005, lat - 0.005],
              [lng + 0.005, lat - 0.005],
              [lng + 0.005, lat + 0.005],
              [lng - 0.005, lat + 0.005],
              [lng - 0.005, lat - 0.005],
            ],
          ],
        },
        properties: props,
      },
    ],
    crs: {
      type: "name",
      properties: { name: "urn:ogc:def:crs:EPSG::4326" },
    },
  };
}

// ---------------------------------------------------------------------------
// 座標抽出ヘルパー
// ---------------------------------------------------------------------------

/**
 * WFS CQL_FILTER "CONTAINS(the_geom,POINT(lng lat))" から座標を取り出す。
 * 失敗したら null を返す。
 */
function parseCqlPoint(cqlFilter) {
  const m = cqlFilter?.match(/POINT\(([^\s)]+)\s+([^\s)]+)\)/i);
  if (!m) return null;
  return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

// ---------------------------------------------------------------------------
// HTTP サーバー
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS (Next.js dev server からの呼び出し対応)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ------------------------------------------------------------------
  // WFS エンドポイント: GET /geoserver/ksj/ows
  // ------------------------------------------------------------------
  if (pathname === "/geoserver/ksj/ows") {
    const service  = url.searchParams.get("service")  ?? "";
    const request  = url.searchParams.get("request")  ?? "";

    // GetCapabilities — healthCheck 用
    if (service.toUpperCase() === "WFS" && request.toLowerCase() === "getcapabilities") {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><WFS_Capabilities version="1.0.0"><FeatureTypeList><FeatureType><Name>ksj:A29</Name></FeatureType></FeatureTypeList></WFS_Capabilities>`;
      res.writeHead(200, { "Content-Type": "application/xml; charset=UTF-8" });
      res.end(xml);
      console.log(`  [WFS] GetCapabilities`);
      return;
    }

    // GetFeature
    if (service.toUpperCase() === "WFS" && request.toLowerCase() === "getfeature") {
      const cql    = url.searchParams.get("CQL_FILTER") ?? "";
      const coords = parseCqlPoint(cql);
      const lat    = coords?.lat ?? 35.6812;
      const lng    = coords?.lng ?? 139.7671;
      const props  = resolveZoningProps(lat, lng);
      const body   = JSON.stringify(buildGeoJson(props, lat, lng));

      res.writeHead(200, { "Content-Type": "application/json; charset=UTF-8" });
      res.end(body);
      console.log(`  [WFS] GetFeature lat=${lat} lng=${lng} → A29_002=${props.A29_002}`);
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unsupported WFS request" }));
    return;
  }

  // ------------------------------------------------------------------
  // カスタム REST フォールバック: GET /a29?lat=&lng=
  // ------------------------------------------------------------------
  if (pathname === "/a29") {
    const lat = parseFloat(url.searchParams.get("lat") ?? "35.6812");
    const lng = parseFloat(url.searchParams.get("lng") ?? "139.7671");
    const props = resolveZoningProps(lat, lng);
    const body  = JSON.stringify(buildGeoJson(props, lat, lng));

    res.writeHead(200, { "Content-Type": "application/json; charset=UTF-8" });
    res.end(body);
    console.log(`  [REST] /a29 lat=${lat} lng=${lng} → A29_002=${props.A29_002}`);
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", path: pathname }));
});

server.listen(PORT, () => {
  console.log("");
  console.log(`Mock KSJ GeoServer  →  http://localhost:${PORT}`);
  console.log("");
  console.log("  .env に以下を設定してください:");
  console.log(`  KSJ_API_URL=http://localhost:${PORT}/geoserver/ksj/ows`);
  console.log("");
  console.log("  疎通確認:");
  console.log(`  http://localhost:${PORT}/geoserver/ksj/ows?service=WFS&version=1.0.0&request=GetCapabilities`);
  console.log(`  http://localhost:${PORT}/geoserver/ksj/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=ksj:A29&outputFormat=application/json&CQL_FILTER=CONTAINS(the_geom,POINT(139.767%2035.681))&maxFeatures=1`);
  console.log("");
});

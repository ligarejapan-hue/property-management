/**
 * /field-survey/map UI (Phase 1-E) のソース静的検証。
 *
 * vitest が node 環境のため、コンポーネントの実 render は次フェーズ以降に
 * 委ねるが、PII 漏洩 / クラッシュ防止 / 権限境界が壊れていないことを
 * ソース文字列レベルで担保する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const PAGE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/field-survey/map/page.tsx"),
  "utf8",
);
const MAP_SRC = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/field-survey/field-survey-map.tsx",
  ),
  "utf8",
);
const SIDEBAR_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/layout/sidebar.tsx"),
  "utf8",
);
const ENV_EXAMPLE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), ".env.example"),
  "utf8",
);

describe(".env.example — Google Maps key", () => {
  it("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY のテンプレ行がある", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/^NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=/m);
  });

  it("HTTP referrer 制限の運用注意がコメントに含まれる", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/HTTP referrer/i);
  });

  it("実 API キー値 (AIza...) をコミットしていない", () => {
    expect(ENV_EXAMPLE_SRC).not.toMatch(/AIza[0-9A-Za-z-_]{20,}/);
  });
});

describe("sidebar.tsx — nav entry", () => {
  it("/field-survey/map への nav item が追加されている", () => {
    expect(SIDEBAR_SRC).toMatch(/href:\s*"\/field-survey\/map"/);
  });

  it("ラベル 現地調査マップ がある", () => {
    expect(SIDEBAR_SRC).toMatch(/現地調査マップ/);
  });
});

describe("page.tsx — fallback / structure", () => {
  it("'use client' で始まる", () => {
    expect(PAGE_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("APIキー未設定時の案内文を持つ", () => {
    expect(PAGE_SRC).toMatch(/Google Maps APIキーが未設定/);
  });

  it("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY を直接参照する", () => {
    expect(PAGE_SRC).toMatch(/process\.env\.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY/);
  });

  it("isGoogleMapsKeyConfigured を介してクラッシュ防御している", () => {
    expect(PAGE_SRC).toMatch(/isGoogleMapsKeyConfigured/);
  });

  it("APIキーをそのまま画面 body に表示していない (露出防止)", () => {
    // page.tsx に apiKey をそのまま {apiKey} として描画する箇所が無いこと
    expect(PAGE_SRC).not.toMatch(/\{apiKey\}/);
  });
});

describe("field-survey-map.tsx — PII / API 境界", () => {
  it("'use client' で始まる", () => {
    expect(MAP_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("既存 Property map API を叩く", () => {
    expect(MAP_SRC).toMatch(/\/api\/field-survey\/map\/properties/);
  });

  it("既存 Pin list API を叩く", () => {
    expect(MAP_SRC).toMatch(/\/api\/field-survey\/pins/);
  });

  it("owner 氏名・住所・電話などの PII field を参照していない", () => {
    expect(MAP_SRC).not.toMatch(/\bownerName\b/);
    expect(MAP_SRC).not.toMatch(/\bownerPhone\b/);
    expect(MAP_SRC).not.toMatch(/\bownerAddress\b/);
    expect(MAP_SRC).not.toMatch(/propertyOwners/);
    expect(MAP_SRC).not.toMatch(/\bowner\.\w+/);
  });

  it("rawData / rawPayloadJson / memo 本文を地図 row に持ち込まない (Property)", () => {
    // PropertyRow interface に rawPayloadJson を入れていない
    expect(MAP_SRC).not.toMatch(/rawPayloadJson/);
    expect(MAP_SRC).not.toMatch(/rawData/);
  });

  it("HTTP error ハンドリングが 401 / 403 / 422 に対応", () => {
    expect(MAP_SRC).toMatch(/status === 401/);
    expect(MAP_SRC).toMatch(/status === 403/);
    expect(MAP_SRC).toMatch(/status === 422/);
  });

  it("AbortController で stale request を中断する", () => {
    expect(MAP_SRC).toMatch(/AbortController/);
  });

  it("debounce を fetch に挟んでいる", () => {
    expect(MAP_SRC).toMatch(/debounce\(/);
  });

  it("巡回開始/終了/現在位置ボタンは disabled (Phase 1-F 予定)", () => {
    // それぞれのボタンが disabled / aria-disabled を持つ
    const tripStartRegion = MAP_SRC.match(
      /巡回開始[\s\S]{0,200}/,
    );
    expect(tripStartRegion).not.toBeNull();
    expect(MAP_SRC).toMatch(/aria-disabled="true"/);
  });

  it("API キーを fetch URL / query / log に流していない", () => {
    expect(MAP_SRC).not.toMatch(/apiKey=\$\{apiKey\}/);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*apiKey/);
  });

  it("lat / lng / bbox を console に出さない", () => {
    // 防御的: コードに console.* で lat/lng/bbox を出すパターンが無いこと
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*bbox/i);
  });
});

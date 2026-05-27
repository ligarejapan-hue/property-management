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

  it("本番運用前チェックリスト 5 項目が明記されている", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/Cloud Billing/);
    expect(ENV_EXAMPLE_SRC).toMatch(/quota/i);
    expect(ENV_EXAMPLE_SRC).toMatch(/HTTP referrer/);
    expect(ENV_EXAMPLE_SRC).toMatch(/Maps JavaScript API/);
    expect(ENV_EXAMPLE_SRC).toMatch(/管理者|承認/);
  });

  it("Budget alert は通知のみ・quota で実停止する旨が明記されている", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/Budget alert.*停止しない|通知のみ/);
    expect(ENV_EXAMPLE_SRC).toMatch(/quota.*上限|quota.*制限/);
  });

  it("NEXT_PUBLIC_GOOGLE_MAPS_BILLING_ACKNOWLEDGED の opt-in 行がある", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(
      /^NEXT_PUBLIC_GOOGLE_MAPS_BILLING_ACKNOWLEDGED=/m,
    );
  });

  it("固定料金 (無料枠 / 単価) を env コメントにハードコードしていない", () => {
    expect(ENV_EXAMPLE_SRC).not.toMatch(/\$\s*\d/);
    expect(ENV_EXAMPLE_SRC).not.toMatch(/28[,\s]?500/);
    expect(ENV_EXAMPLE_SRC).not.toMatch(/\b\d{2,3}\s*円\b/);
    expect(ENV_EXAMPLE_SRC).not.toMatch(/\bper\s*1[,\s]?000\b/i);
    // 「公式ページで確認」の方針宣言があること
    expect(ENV_EXAMPLE_SRC).toMatch(/公式.*料金|料金.*公式/);
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

  it("APIキーが入っていても billing 未確認なら警告 UI を出す", () => {
    // 警告バナーの存在とトリガ条件 (hasKey && !billingAcknowledged) を確認
    expect(PAGE_SRC).toMatch(/isGoogleMapsBillingAcknowledged/);
    expect(PAGE_SRC).toMatch(/BillingNotAcknowledgedBanner/);
    expect(PAGE_SRC).toMatch(/hasKey\s*&&\s*!billingAcknowledged/);
  });

  it("警告 UI に 5 項目チェックリストが含まれる", () => {
    expect(PAGE_SRC).toMatch(/Cloud Billing/);
    expect(PAGE_SRC).toMatch(/quota/i);
    expect(PAGE_SRC).toMatch(/referrer/i);
    expect(PAGE_SRC).toMatch(/Maps JavaScript API/);
    expect(PAGE_SRC).toMatch(/管理者承認/);
  });

  it("警告 UI で Budget alert ≠ 課金停止 を明記している", () => {
    expect(PAGE_SRC).toMatch(/通知のみで課金を停止しません|Budget alert.*通知/);
    expect(PAGE_SRC).toMatch(/quota.*必要/);
  });

  it("page.tsx に固定料金 (無料枠 / 単価) をハードコードしていない", () => {
    expect(PAGE_SRC).not.toMatch(/\$\s*\d/);
    expect(PAGE_SRC).not.toMatch(/28[,\s]?500/);
    expect(PAGE_SRC).not.toMatch(/\b\d{2,3}\s*円\b/);
    expect(PAGE_SRC).not.toMatch(/\bper\s*1[,\s]?000\b/i);
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

  it("map component にも固定料金をハードコードしていない", () => {
    expect(MAP_SRC).not.toMatch(/\$\s*\d/);
    expect(MAP_SRC).not.toMatch(/28[,\s]?500/);
    expect(MAP_SRC).not.toMatch(/\b\d{2,3}\s*円\b/);
    expect(MAP_SRC).not.toMatch(/\bper\s*1[,\s]?000\b/i);
  });

  it("map component / page から料金関連内部設定値を console / error に流さない", () => {
    // billing / budget / quota の内部値を出力に混ぜないこと
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*billing/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*quota/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*budget/i);
    expect(PAGE_SRC).not.toMatch(/console\.\w+\([^)]*billing/i);
    expect(PAGE_SRC).not.toMatch(/console\.\w+\([^)]*quota/i);
    expect(PAGE_SRC).not.toMatch(/console\.\w+\([^)]*budget/i);
  });
});

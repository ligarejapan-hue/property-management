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

  it("NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID を optional / 任意 と書いていない", () => {
    // 行頭の env テンプレ自体は残るが、その上の説明 block 内で "(任意)" /
    // "optional" と記載しない (AdvancedMarker のため必須)。
    const mapIdBlock = ENV_EXAMPLE_SRC.match(
      /[\s\S]{0,400}NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=/,
    );
    expect(mapIdBlock).not.toBeNull();
    expect(mapIdBlock?.[0]).not.toMatch(/\(任意\)/);
    expect(mapIdBlock?.[0]).not.toMatch(/optional/i);
  });

  it("MAP_ID が AdvancedMarker に必須である旨が明記されている", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/AdvancedMarker.*必須|必須.*AdvancedMarker/);
    expect(ENV_EXAMPLE_SRC).toMatch(/壊れた\s*UI|マーカー.*表示されない/);
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

  it("APIキーが入っていても billing 未確認なら FieldSurveyMap を mount しない (Codex P1)", () => {
    // gating: ack 未確認時は fallback (= FieldSurveyMap を mount しない)
    expect(PAGE_SRC).toMatch(/isGoogleMapsBillingAcknowledged/);
    expect(PAGE_SRC).toMatch(/BillingNotAcknowledgedFallback/);
    // FieldSurveyMap の render は ternary の false 分岐 (= ack 済) でのみ。
    // !billingAcknowledged ? (...Fallback...) : (<FieldSurveyMap ...) の構造を要求。
    expect(PAGE_SRC).toMatch(
      /!billingAcknowledged\s*\?\s*\([\s\S]*?BillingNotAcknowledgedFallback[\s\S]*?\)\s*:\s*\(\s*<FieldSurveyMap/,
    );
    // FieldSurveyMap の render は 1 箇所のみ (重複 mount 経路がない)
    const matches = PAGE_SRC.match(/<FieldSurveyMap\b/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("fallback UI に 5 項目チェックリストが含まれる", () => {
    expect(PAGE_SRC).toMatch(/Cloud Billing/);
    expect(PAGE_SRC).toMatch(/quota/i);
    expect(PAGE_SRC).toMatch(/referrer/i);
    expect(PAGE_SRC).toMatch(/Maps JavaScript API/);
    expect(PAGE_SRC).toMatch(/管理者.*承認|本番利用承認/);
  });

  it("fallback UI で Budget alert ≠ 課金停止 を明記している", () => {
    expect(PAGE_SRC).toMatch(/通知のみで課金を停止しません|Budget alert.*通知/);
    expect(PAGE_SRC).toMatch(/quota.*必要/);
  });

  it("fallback UI で APIキーの値を表示しない", () => {
    // APIキー string を直接 render に渡す箇所がないこと
    expect(PAGE_SRC).not.toMatch(/\{apiKey\}/);
  });

  it("APIキー + 課金承認済でも MAP_ID 未設定なら FieldSurveyMap を mount しない (Codex Phase 1-E)", () => {
    // 4 段 ternary: !hasKey → MissingKeyNotice / !billingAcknowledged →
    // BillingNotAcknowledgedFallback / !hasMapId → MissingMapIdFallback /
    // else → FieldSurveyMap
    expect(PAGE_SRC).toMatch(/isGoogleMapsMapIdConfigured/);
    expect(PAGE_SRC).toMatch(/MissingMapIdFallback/);
    expect(PAGE_SRC).toMatch(
      /!hasMapId\s*\?\s*\([\s\S]*?MissingMapIdFallback[\s\S]*?\)\s*:\s*\(\s*<FieldSurveyMap/,
    );
    // <FieldSurveyMap> の render 経路は 1 箇所のみ
    const matches = PAGE_SRC.match(/<FieldSurveyMap\b/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("MissingMapIdFallback に MAP_ID 設定指示と壊れた UI 注意がある", () => {
    expect(PAGE_SRC).toMatch(/NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID/);
    expect(PAGE_SRC).toMatch(/AdvancedMarker/);
    expect(PAGE_SRC).toMatch(/壊れた\s*UI|表示されない/);
    expect(PAGE_SRC).toMatch(/build\s*\/\s*restart|build.*restart/i);
  });

  it("FieldSurveyMap の mapId prop に as string を明示 (mapId 必須宣言)", () => {
    expect(PAGE_SRC).toMatch(/mapId=\{mapId\s+as\s+string\}/);
  });

  it("FieldSurveyMapProps の mapId は optional ではない (必須)", () => {
    const propsDecl = MAP_SRC.match(
      /interface FieldSurveyMapProps[\s\S]*?^\}/m,
    );
    expect(propsDecl).not.toBeNull();
    // "mapId?" optional 構文が無いこと
    expect(propsDecl?.[0]).not.toMatch(/\bmapId\?:/);
    // "mapId:" (非 optional) があること
    expect(propsDecl?.[0]).toMatch(/\bmapId:\s*string/);
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

  it("Pin InfoWindow に memo 本文を表示しない (Codex P2)", () => {
    // PinInfo 関数内で row.memo を直接 render しない
    const pinInfo = MAP_SRC.match(/function PinInfo[\s\S]*?^\}/m);
    expect(pinInfo).not.toBeNull();
    expect(pinInfo?.[0]).not.toMatch(/row\.memo/);
    expect(pinInfo?.[0]).not.toMatch(/\{[^}]*memo[^}]*\}/);
    // hasMemo の boolean のみで「あり」「—」を切り替える
    expect(pinInfo?.[0]).toMatch(/hasMemo/);
  });

  it("PinRow 型 / state に memo 本文を持ち回らない", () => {
    // PinRow interface に memo 本文 field を含めない (hasMemo のみ)
    const pinRowDecl = MAP_SRC.match(/interface PinRow[\s\S]*?^\}/m);
    expect(pinRowDecl).not.toBeNull();
    // "memo:" 単独 field がない (hasMemo は別語)
    expect(pinRowDecl?.[0]).not.toMatch(/\bmemo:\s*string/);
    expect(pinRowDecl?.[0]).toMatch(/hasMemo/);
  });

  it("API レスポンス受け取りで memo を捨てる stripPinMemo を経由", () => {
    expect(MAP_SRC).toMatch(/stripPinMemo/);
  });

  it("Pin fetch URL に bbox (north/south/east/west) が含まれる (Codex P2)", () => {
    // pin fetch 経路で URLSearchParams に bbox 4 値が積まれる
    const pinFetchRegion = MAP_SRC.match(
      /api\/field-survey\/pins[\s\S]{0,400}/,
    );
    expect(pinFetchRegion).not.toBeNull();
    // URLSearchParams object literal shorthand の key を検出
    expect(MAP_SRC).toMatch(/\bnorth:\s*String\(/);
    expect(MAP_SRC).toMatch(/\bsouth:\s*String\(/);
    expect(MAP_SRC).toMatch(/\beast:\s*String\(/);
    expect(MAP_SRC).toMatch(/\bwest:\s*String\(/);
    // 単純な ?limit のみのリクエストになっていないこと
    expect(MAP_SRC).not.toMatch(
      /\/api\/field-survey\/pins\?limit=\$\{[^}]+\}["'`]/,
    );
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

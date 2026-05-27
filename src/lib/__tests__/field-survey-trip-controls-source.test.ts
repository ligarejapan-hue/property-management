/**
 * Phase 1-F-1 巡回 UI のソース静的検証。
 *
 * 主目的:
 * - navigator.geolocation / watchPosition / getCurrentPosition を使っていない
 *   (これらは Phase 1-F-2 で追加)
 * - localStorage / sessionStorage / IndexedDB に session / 位置情報を保存しない
 * - console.* に API key / lat / lng / bbox / API response 全文 / PII を出さない
 * - 巡回開始 / 終了ボタンと注意文言が存在する
 * - 「常時監視ではない」「位置情報の記録は次フェーズで追加」旨が UI に明示
 * - Phase 1-E までの gating 設計を壊していない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const TRIP_SRC = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/field-survey/trip-controls.tsx",
  ),
  "utf8",
);
const MAP_SRC = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/field-survey/field-survey-map.tsx",
  ),
  "utf8",
);
const PAGE_SRC = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/field-survey/map/page.tsx",
  ),
  "utf8",
);

describe("trip-controls.tsx — Phase 1-F-1 scope (no geolocation, no persistence)", () => {
  it("'use client' で始まる", () => {
    expect(TRIP_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("navigator.geolocation / watchPosition / getCurrentPosition / clearWatch の呼び出しが無い", () => {
    // コメントで Phase 1-F-2 以降の扱いを述べているため、実 method 呼び出しのみ検出。
    expect(TRIP_SRC).not.toMatch(
      /navigator\s*\.\s*geolocation\s*\.\s*(watchPosition|getCurrentPosition|clearWatch)/,
    );
    expect(TRIP_SRC).not.toMatch(
      /geolocation\s*\.\s*(watchPosition|getCurrentPosition|clearWatch)\s*\(/,
    );
  });

  it("localStorage / sessionStorage / IndexedDB の API 呼び出しが無い", () => {
    // bare word はコメントで負/不使用を明示している箇所があるため、実 API 呼び出し
    // パターン (.setItem / .getItem / window.* / indexedDB.open / .transaction) のみ検出。
    expect(TRIP_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(TRIP_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(TRIP_SRC).not.toMatch(/window\.\s*(localStorage|sessionStorage)/);
    expect(TRIP_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
    expect(TRIP_SRC).not.toMatch(/IDBDatabase|IDBObjectStore/);
  });

  it("Wake Lock API の呼び出しが無い (Phase 1-F-1 では未対応)", () => {
    expect(TRIP_SRC).not.toMatch(/navigator\.\s*wakeLock/);
    expect(TRIP_SRC).not.toMatch(/wakeLock\s*\.\s*request/);
  });

  it("console.* で lat / lng / bbox / API key / env 値 / API response 全文を出さない", () => {
    expect(TRIP_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(TRIP_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(TRIP_SRC).not.toMatch(/console\.\w+\([^)]*bbox/i);
    expect(TRIP_SRC).not.toMatch(/console\.\w+\([^)]*apiKey/i);
    expect(TRIP_SRC).not.toMatch(/console\.\w+\([^)]*env/i);
    expect(TRIP_SRC).not.toMatch(/console\.\w+\([^)]*body/i);
    // 「console に json で全文吐く」パターン
    expect(TRIP_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });

  it("巡回開始 / 終了ボタン / 注意文言 modal が存在する", () => {
    expect(TRIP_SRC).toMatch(/巡回開始/);
    expect(TRIP_SRC).toMatch(/巡回終了/);
    expect(TRIP_SRC).toMatch(/trip-start-button/);
    expect(TRIP_SRC).toMatch(/trip-end-button/);
    expect(TRIP_SRC).toMatch(/trip-confirm-start-modal/);
    expect(TRIP_SRC).toMatch(/trip-confirm-end-modal/);
  });

  it("注意文言に「常時監視ではない」旨と「位置情報は次フェーズ」旨がある", () => {
    expect(TRIP_SRC).toMatch(/常時監視ではありません/);
    expect(TRIP_SRC).toMatch(/Phase 1-F-2|次フェーズ/);
  });

  it("active session 取得 / 開始 / 終了の各 API path を呼ぶ", () => {
    expect(TRIP_SRC).toMatch(/\/api\/field-survey\/sessions\?status=active/);
    // POST sessions (新規開始)
    expect(TRIP_SRC).toMatch(/fetch\("\/api\/field-survey\/sessions",\s*\{[\s\S]*?method:\s*"POST"/);
    // PATCH sessions/[id]
    expect(TRIP_SRC).toMatch(/method:\s*"PATCH"/);
    expect(TRIP_SRC).toMatch(/encodeURIComponent/);
  });

  it("409 系の outcome を経由して active を再取得する設計", () => {
    expect(TRIP_SRC).toMatch(/conflict_active/);
    expect(TRIP_SRC).toMatch(/conflict_state/);
    expect(TRIP_SRC).toMatch(/fetchActiveSession/);
  });

  it("AuditLog 系 API を UI から直接書かない", () => {
    expect(TRIP_SRC).not.toMatch(/audit/i);
  });

  it("固定料金 / 無料枠数値をハードコードしない (継続ガード)", () => {
    expect(TRIP_SRC).not.toMatch(/\$\s*\d/);
    expect(TRIP_SRC).not.toMatch(/28[,\s]?500/);
    expect(TRIP_SRC).not.toMatch(/\b\d{2,3}\s*円\b/);
    expect(TRIP_SRC).not.toMatch(/\bper\s*1[,\s]?000\b/i);
  });
});

describe("field-survey-map.tsx — TripControls 統合", () => {
  it("TripControls を import して ControlPanel から呼ぶ", () => {
    expect(MAP_SRC).toMatch(/import\s+TripControls/);
    expect(MAP_SRC).toMatch(/<TripControls\s+currentUserId=\{currentUserId\}/);
  });

  it("ControlPanel から旧 disabled 巡回開始 / 終了ボタンが消えている", () => {
    // ControlPanel 内に「巡回開始」「巡回終了」リテラル button text が残っていないこと
    // (TripControls に移譲済み)。検索: aria-disabled の disabled な「巡回開始」「巡回終了」が無い。
    const cp = MAP_SRC.match(/function ControlPanel[\s\S]*?\n\}/);
    expect(cp).not.toBeNull();
    expect(cp?.[0]).not.toMatch(/巡回開始/);
    expect(cp?.[0]).not.toMatch(/巡回終了/);
  });

  it("FieldSurveyMapProps.currentUserId が必須として定義されている", () => {
    const propsDecl = MAP_SRC.match(
      /interface FieldSurveyMapProps[\s\S]*?^\}/m,
    );
    expect(propsDecl).not.toBeNull();
    expect(propsDecl?.[0]).toMatch(/\bcurrentUserId:\s*string/);
    expect(propsDecl?.[0]).not.toMatch(/\bcurrentUserId\?:/);
  });

  it("MAP_SRC で navigator.geolocation 等を引き続き使っていない (Phase 1-F-1 スコープ)", () => {
    expect(MAP_SRC).not.toMatch(/navigator\.geolocation/);
    expect(MAP_SRC).not.toMatch(/watchPosition/);
    expect(MAP_SRC).not.toMatch(/getCurrentPosition/);
    expect(MAP_SRC).not.toMatch(/wakeLock/);
  });

  it("現在位置ボタンは引き続き disabled placeholder のまま", () => {
    expect(MAP_SRC).toMatch(/現在位置\s*\(準備中\)/);
  });
});

describe("page.tsx — currentUserId を server side で確定して渡す", () => {
  it("FieldSurveyMapClient に currentUserId prop を渡す", () => {
    expect(PAGE_SRC).toMatch(
      /<FieldSurveyMapClient\s+currentUserId=\{currentUserId\}/,
    );
  });

  it("currentUserId は canRead 経路でのみ session.id から確定", () => {
    expect(PAGE_SRC).toMatch(/let\s+currentUserId/);
    expect(PAGE_SRC).toMatch(/canRead\s*&&\s*currentUserId/);
    expect(PAGE_SRC).toMatch(/if\s*\(canRead\)\s*currentUserId\s*=\s*session\.id/);
  });
});

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

  it("注意文言に「常時監視ではない」「位置記録は別操作」旨がある", () => {
    expect(TRIP_SRC).toMatch(/常時監視ではありません/);
    // Phase 1-F-2 以降: 巡回開始 ≠ 位置記録開始 を明示
    expect(TRIP_SRC).toMatch(/位置記録開始/);
  });

  it("active session 取得 / 開始 / 終了の各 API path を呼ぶ", () => {
    expect(TRIP_SRC).toMatch(/\/api\/field-survey\/sessions\?status=active/);
    // POST sessions (新規開始)
    expect(TRIP_SRC).toMatch(/fetch\("\/api\/field-survey\/sessions",\s*\{[\s\S]*?method:\s*"POST"/);
    // PATCH sessions/[id]
    expect(TRIP_SRC).toMatch(/method:\s*"PATCH"/);
    expect(TRIP_SRC).toMatch(/encodeURIComponent/);
  });

  // --- Codex P2: active session refetch を currentUserId で絞る -------------

  it("active session 取得 URL に staffUserId=currentUserId と limit=1 を含む", () => {
    expect(TRIP_SRC).toMatch(
      /\/api\/field-survey\/sessions\?status=active[\s\S]*?staffUserId=\$\{encodeURIComponent\(currentUserId\)\}/,
    );
    expect(TRIP_SRC).toMatch(/limit=1\b/);
  });

  it("staffUserId 無しの古い limit=10 取得 URL が残っていない (退行防止)", () => {
    // 「status=active と limit=10 を同じ URL 文字列に含む」古い pattern が無いこと
    const hasOld = /status=active[\s\S]{0,80}limit=10/.test(TRIP_SRC) ||
      /limit=10[\s\S]{0,80}status=active/.test(TRIP_SRC);
    expect(hasOld).toBe(false);
  });

  // --- Codex P2: mutation の AbortController + mounted guard ----------------

  it("POST sessions / 終了 PATCH に signal が渡される", () => {
    // POST 経路: method: "POST" を含む fetch 呼び出し block 内に signal がある
    const postRegion = TRIP_SRC.match(
      /method:\s*"POST"[\s\S]*?\)\s*;/,
    );
    expect(postRegion).not.toBeNull();
    expect(postRegion?.[0]).toMatch(/signal:\s*\w+\.signal/);
    // 終了 PATCH 経路 (status: "ended" を送る fetch) にも signal がある。
    // #317 R3 で body にフェンストークン (expectedUpdatedAt) の条件付き spread が
    // 加わったため、body 終端〜signal までを許容幅で掴む。
    // ※続行 touch の memo-only PATCH は fire-and-forget のため対象外 (B-7 @codex R6)
    expect(TRIP_SRC).toMatch(
      /status:\s*"ended",[\s\S]{0,300}?\}\),\s*signal:\s*\w+\.signal/,
    );
  });

  it("active fetch と mutation で AbortController を分離している", () => {
    expect(TRIP_SRC).toMatch(/activeFetchAbortRef/);
    expect(TRIP_SRC).toMatch(/mutationAbortRef/);
  });

  it("unmount cleanup で active fetch と mutation の両方を abort する", () => {
    const cleanupRegion = TRIP_SRC.match(
      /return\s*\(\)\s*=>\s*\{[\s\S]*?mountedRef\.current\s*=\s*false[\s\S]*?\}/,
    );
    expect(cleanupRegion).not.toBeNull();
    expect(cleanupRegion?.[0]).toMatch(/activeFetchAbortRef[\s\S]*?abort\(\)/);
    expect(cleanupRegion?.[0]).toMatch(/mutationAbortRef[\s\S]*?abort\(\)/);
  });

  it("mountedRef による unmount 後 setState 抑止がある", () => {
    expect(TRIP_SRC).toMatch(/mountedRef/);
    // handler 内で mountedRef.current チェックが複数回現れる
    const checks = TRIP_SRC.match(/!mountedRef\.current/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(3);
  });

  it("AbortError はユーザー向けエラー文言に変換しない", () => {
    // isAbortError(err) で握って return している
    expect(TRIP_SRC).toMatch(/isAbortError\(err\)/);
    // 「AbortError」を error UI に直接出さない
    expect(TRIP_SRC).not.toMatch(/setError\([^)]*AbortError/);
  });

  it("409 系の outcome を経由して active を再取得する設計", () => {
    // 開始側の 409 (conflict_active) は個別 branch で再取得。
    expect(TRIP_SRC).toMatch(/conflict_active/);
    // 終了側の 409 (conflict_state) を含む非 ok は @codex P1 R10 で「曖昧」に
    // 統一し、reconcile (fetchActiveSession) で active を再取得する。
    expect(TRIP_SRC).toMatch(/ambiguous = true/);
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

// --- B-7 (UI総点検): 終了し忘れ巡回の「次回表示時の終了確認」 ---------------

describe("trip-controls.tsx — B-7 放置巡回の終了確認", () => {
  it("放置判定 helper (isSessionStale / 閾値 / 表示用 formatter) を import する", () => {
    expect(TRIP_SRC).toMatch(/isSessionStale/);
    expect(TRIP_SRC).toMatch(/STALE_CONFIRM_THRESHOLD_MS/);
    expect(TRIP_SRC).toMatch(/formatStaleDuration/);
  });

  it("phase に confirmStaleEnd があり、専用モーダルを描画する", () => {
    expect(TRIP_SRC).toMatch(/"confirmStaleEnd"/);
    expect(TRIP_SRC).toMatch(/trip-confirm-stale-end-modal/);
  });

  it("モーダルは「終了する」と「巡回を続ける」の二択", () => {
    expect(TRIP_SRC).toMatch(/巡回を続ける/);
    expect(TRIP_SRC).toMatch(/終了されないまま残っています/);
  });

  it("同じ session への確認は 1 回だけ (再取得のたびに聞き直さない)", () => {
    expect(TRIP_SRC).toMatch(/stalePromptedRef/);
  });

  it("放置判定は最終活動時刻ベース (@codex R3・記録中の session に出さない)", () => {
    expect(TRIP_SRC).toMatch(/own\.updatedAt \?\? own\.startedAt/);
  });

  it("終了は既存 PATCH を流用・続行は touch PATCH で活動のみ記録 (@codex R6/R7)", () => {
    // 専用の別 API は増やさない (end 用 + 続行 touch 用の PATCH 2 箇所のみ)
    const patches = TRIP_SRC.match(/method:\s*"PATCH"/g) ?? [];
    expect(patches.length).toBe(2);
    // 続行 touch は活動記録専用 ({ touch: true })。memo 送信での代用は
    // 一覧 API が memo を返さないため既存 memo を消す (禁止)
    expect(TRIP_SRC).toMatch(/touchSession/);
    expect(TRIP_SRC).toMatch(/JSON\.stringify\(\{ touch: true \}\)/);
    expect(TRIP_SRC).not.toMatch(/memo:\s*target\.memo/);
    // 並行終了済み (409) は再取得して UI を整合させる (@codex R9)
    expect(TRIP_SRC).toMatch(
      /409[\s\S]{0,300}?fetchActiveSession\(\)/,
    );
  });

  it("終了直前の touch (@codex R10 の stale 解除 + #317 R3/R4 フェンストークン発行)", () => {
    expect(TRIP_SRC).toMatch(/resumedRef/);
    // endSession 内で (stale 直接終了を除き) touchSession を await してから
    // 終了 PATCH。続行済み session の stale 巻き戻り防止 (R10) はこの一般化
    // された touch が兼ねる。トークンは終了 PATCH に必ず echo される。
    expect(TRIP_SRC).toMatch(
      /\} else \{\s*const fence = await touchSession\(target\)/,
    );
    expect(TRIP_SRC).toMatch(/expectedUpdatedAt: fenceToken/);
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

  it("MAP_SRC は watchPosition / Wake Lock を呼ばない (連続追跡は hook 経由のみ)", () => {
    // Phase 1-F-2: 連続位置追跡 (watchPosition) は hook 側に閉じる。
    // Phase 1-G: 「現在地を使う」での単発 getCurrentPosition のみ map から
    // 呼ばれてよい (RouteRecorder hook は流用しない方針)。
    expect(MAP_SRC).not.toMatch(/watchPosition\s*\(/);
    expect(MAP_SRC).not.toMatch(/wakeLock/);
  });

  it("Phase 1-F-2: 位置記録 UI + polyline を組み込む", () => {
    expect(MAP_SRC).toMatch(/LocationRecorderControls/);
    expect(MAP_SRC).toMatch(/RoutePolyline/);
    expect(MAP_SRC).toMatch(/useFieldSurveyLocationRecorder/);
    // 現在位置の disabled placeholder は撤去済 (実機能に置換)
    expect(MAP_SRC).not.toMatch(/現在位置\s*\(準備中\)/);
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

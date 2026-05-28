/**
 * Phase 1-J: 巡回セッション一覧 / 過去ルート閲覧 (履歴モード) のソース静的検証。
 *
 * - 履歴モードは完全 read-only: 記録系 UI / watchPosition / TrackPoint POST /
 *   pin 作成・編集・削除・写真追加削除を一切持ち込まないことを構造的に担保する。
 * - 座標 / memo / 写真URL / storageKey / PII を console に出さない。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

const HISTORY_SRC = readSrc(
  "src/components/field-survey/field-survey-history-map.tsx",
);
const CLIENT_SRC = readSrc(
  "src/components/field-survey/field-survey-map-client.tsx",
);
const LIST_SRC = readSrc(
  "src/components/field-survey/session-history-client.tsx",
);
const PAGE_SRC = readSrc("src/app/(dashboard)/field-survey/sessions/page.tsx");
const SIDEBAR_SRC = readSrc("src/components/layout/sidebar.tsx");
const DETAIL_SRC = readSrc("src/components/field-survey/pin-detail-panel.tsx");

// =======================================================================
// sessions 一覧ページ / sidebar
// =======================================================================
describe("session history list page", () => {
  it("server 側で field_survey:read を gate する", () => {
    expect(PAGE_SRC).toMatch(/hasPermission\([\s\S]*?"field_survey"[\s\S]*?"read"/);
  });

  it("canSeeAll を read_all または manage で算出する", () => {
    expect(PAGE_SRC).toMatch(/"read_all"/);
    expect(PAGE_SRC).toMatch(/"manage"/);
    expect(PAGE_SRC).toMatch(/canSeeAll/);
  });

  it("一覧 client は scope / status フィルタを持つ", () => {
    expect(LIST_SRC).toMatch(/data-testid="session-history-scope"/);
    expect(LIST_SRC).toMatch(/data-testid="session-history-status"/);
  });

  it("「地図で見る」が /field-survey/map?sessionId= を使う", () => {
    expect(LIST_SRC).toMatch(/data-testid="session-history-view-map"/);
    expect(LIST_SRC).toMatch(/\/field-survey\/map\?sessionId=/);
  });

  it("全員 scope は canSeeAll の時のみ表示する", () => {
    expect(LIST_SRC).toMatch(/canSeeAll\s*&&/);
  });

  it("一覧 client は座標/memo/写真/PII を出さず console も使わない", () => {
    expect(LIST_SRC).not.toMatch(/dangerouslySetInnerHTML/);
    expect(LIST_SRC).not.toMatch(/console\.\w+\(/);
    expect(LIST_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(LIST_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(LIST_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
  });

  it("sidebar に巡回履歴 (/field-survey/sessions) がある", () => {
    expect(SIDEBAR_SRC).toMatch(/巡回履歴/);
    expect(SIDEBAR_SRC).toMatch(/\/field-survey\/sessions/);
  });
});

// =======================================================================
// map client の履歴モード分岐
// =======================================================================
describe("field-survey-map-client history branch", () => {
  it("useSearchParams で sessionId を読む", () => {
    expect(CLIENT_SRC).toMatch(/useSearchParams/);
    expect(CLIENT_SRC).toMatch(/sessionId/);
  });

  it("historySessionId がある時のみ FieldSurveyHistoryMap に分岐する", () => {
    expect(CLIENT_SRC).toMatch(/if\s*\(historySessionId\)/);
    expect(CLIENT_SRC).toMatch(/<FieldSurveyHistoryMap/);
  });

  it("sessionId は UUID 形式のみ受け付ける (不正値を弾く)", () => {
    expect(CLIENT_SRC).toMatch(/isValidUuid/);
  });
});

// =======================================================================
// 履歴モード (FieldSurveyHistoryMap) は完全 read-only
// =======================================================================
describe("field-survey-history-map (read-only)", () => {
  it("'use client' で始まる", () => {
    expect(HISTORY_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("RoutePolyline に過去 track points (routePoints) を渡す", () => {
    expect(HISTORY_SRC).toMatch(/<RoutePolyline\s+points=\{routePoints\}/);
  });

  it("session meta + track-points を GET で取得する", () => {
    expect(HISTORY_SRC).toMatch(/\/api\/field-survey\/sessions\/\$\{encodeURIComponent\(sessionId\)\}/);
    expect(HISTORY_SRC).toMatch(/\/track-points\?/);
  });

  it("session に紐づく pin だけを取得する (sessionId filter)", () => {
    expect(HISTORY_SRC).toMatch(/\/api\/field-survey\/pins\?/);
    expect(HISTORY_SRC).toMatch(/sessionId/);
  });

  it("記録系 UI を mount しない (TripControls / LocationRecorderControls / 現在地)", () => {
    expect(HISTORY_SRC).not.toMatch(/TripControls/);
    expect(HISTORY_SRC).not.toMatch(/LocationRecorderControls/);
    expect(HISTORY_SRC).not.toMatch(/CurrentLocationStatus/);
    expect(HISTORY_SRC).not.toMatch(/CurrentLocationMarker/);
    expect(HISTORY_SRC).not.toMatch(/PinAddModeToggle/);
    expect(HISTORY_SRC).not.toMatch(/PinCreateModal/);
  });

  it("位置記録 hook / watchPosition / getCurrentPosition を使わない", () => {
    expect(HISTORY_SRC).not.toMatch(/useFieldSurveyLocationRecorder/);
    expect(HISTORY_SRC).not.toMatch(/watchPosition/);
    expect(HISTORY_SRC).not.toMatch(/getCurrentPosition/);
  });

  it("TrackPoint POST を呼ばない (GET のみ)", () => {
    expect(HISTORY_SRC).not.toMatch(/method:\s*"POST"/);
    expect(HISTORY_SRC).not.toMatch(/method:\s*"PATCH"/);
    expect(HISTORY_SRC).not.toMatch(/method:\s*"DELETE"/);
  });

  it("map click による pin 作成を持たない", () => {
    expect(HISTORY_SRC).not.toMatch(/addListener\(\s*"click"/);
    expect(HISTORY_SRC).not.toMatch(/createPin/);
  });

  it("PinDetailPanel を readOnly で開く", () => {
    expect(HISTORY_SRC).toMatch(/<PinDetailPanel[\s\S]*?readOnly/);
  });

  it("履歴閲覧中バナーと通常マップへ戻る導線がある", () => {
    expect(HISTORY_SRC).toMatch(/data-testid="history-mode-banner"/);
    expect(HISTORY_SRC).toMatch(/data-testid="history-back-to-map"/);
    expect(HISTORY_SRC).toMatch(/href="\/field-survey\/map"/);
  });

  it("座標 / memo / 写真URL / PII を console に出さない / Storage を使わない", () => {
    expect(HISTORY_SRC).not.toMatch(/console\.\w+\(/);
    expect(HISTORY_SRC).not.toMatch(/dangerouslySetInnerHTML/);
    expect(HISTORY_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(HISTORY_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(HISTORY_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
  });
});

// =======================================================================
// PinDetailPanel readOnly
// =======================================================================
describe("PinDetailPanel readOnly", () => {
  it("readOnly prop を受け取る", () => {
    expect(DETAIL_SRC).toMatch(/readOnly\s*=\s*false/);
  });

  it("canEditOwn = !readOnly && isOwn で編集系を抑止する", () => {
    expect(DETAIL_SRC).toMatch(/canEditOwn\s*=\s*!readOnly\s*&&\s*isOwn/);
  });

  it("削除ボタンも readOnly では出さない (canDelete に !readOnly)", () => {
    expect(DETAIL_SRC).toMatch(/canDelete\s*=\s*[\s\S]*?!readOnly/);
  });

  it("写真追加/削除は canEditOwn 経由 (readOnly で抑止)", () => {
    expect(DETAIL_SRC).toMatch(
      /canEdit=\{canEditOwn\s*&&\s*detail!\.status\s*!==\s*"archived"\}/,
    );
  });
});

// =======================================================================
// Phase 1-J Codex P2: 自動 fitBounds / pins pagination
// =======================================================================
describe("history map — auto fit bounds after load (Codex P2)", () => {
  it("map instance を useMap で取得し保持する (MapInstanceCapture)", () => {
    expect(HISTORY_SRC).toMatch(/useMap/);
    expect(HISTORY_SRC).toMatch(/MapInstanceCapture/);
    expect(HISTORY_SRC).toMatch(/setMapInstance/);
  });

  it("load 後に fitBounds / panTo で表示範囲へ移動する (defaultCenter 依存のみではない)", () => {
    expect(HISTORY_SRC).toMatch(/fitBounds/);
    expect(HISTORY_SRC).toMatch(/panTo/);
    // routePoints 優先、無ければ pins を bounds に含める
    expect(HISTORY_SRC).toMatch(
      /routePoints\.length\s*>\s*0\s*\?\s*routePoints\s*:\s*pins/,
    );
  });

  it("sessionId 変更で自動 fit 状態 (hasFitRef) が reset される", () => {
    expect(HISTORY_SRC).toMatch(/hasFitRef/);
    expect(HISTORY_SRC).toMatch(
      /hasFitRef\.current\s*=\s*false[\s\S]*?\}\,\s*\[sessionId\]/,
    );
  });

  it("map instance / google 未取得時は安全に return する (SSR 安全)", () => {
    expect(HISTORY_SRC).toMatch(/if\s*\(!mapInstance\)\s*return/);
    expect(HISTORY_SRC).toMatch(/typeof\s+window\s*!==\s*"undefined"/);
    expect(HISTORY_SRC).toMatch(/LatLngBounds/);
  });

  it("自動 fit useEffect の依存に routePoints / pins / mapInstance を含む", () => {
    expect(HISTORY_SRC).toMatch(/\}\,\s*\[mapInstance,\s*routePoints,\s*pins\]/);
  });
});

describe("history map — paginate all session pins (Codex P2)", () => {
  it("pins を nextCursor で全件ページングする (cursor を追う)", () => {
    expect(HISTORY_SRC).toMatch(/pinCursor/);
    expect(HISTORY_SRC).toMatch(/nextCursor/);
    expect(HISTORY_SRC).toMatch(/pinQs\.set\("cursor",\s*pinCursor\)/);
  });

  it("pagination 上限 (PIN_PAGE_MAX) を持つ", () => {
    expect(HISTORY_SRC).toMatch(/PIN_PAGE_MAX/);
    expect(HISTORY_SRC).toMatch(/for\s*\([\s\S]*?i\s*<\s*PIN_PAGE_MAX/);
  });

  it("上限到達かつ nextCursor 残存時に truncated 警告を出す (座標なし)", () => {
    expect(HISTORY_SRC).toMatch(/pinsTruncated/);
    expect(HISTORY_SRC).toMatch(/data-testid="history-pins-truncated"/);
    expect(HISTORY_SRC).toMatch(/一部のみ表示されています/);
  });

  it("limit=100 1 回だけで終わらない (ループ内で fetch)", () => {
    // for ループ内で pins API を fetch している (単発 fetch ではない)
    const loop = HISTORY_SRC.match(
      /for\s*\([\s\S]*?i\s*<\s*PIN_PAGE_MAX[\s\S]*?\/api\/field-survey\/pins/,
    );
    expect(loop).not.toBeNull();
  });

  it("archived pin は引き続き初期表示しない (includeArchived を付けない)", () => {
    expect(HISTORY_SRC).not.toMatch(/includeArchived/);
  });

  it("pins pagination でも console / raw response を出さない", () => {
    expect(HISTORY_SRC).not.toMatch(/console\.\w+\(/);
  });
});

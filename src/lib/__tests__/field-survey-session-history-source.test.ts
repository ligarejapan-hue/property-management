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
const SIDEBAR_SRC = readSrc("src/components/layout/sidebar-model.tsx");
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
    // hasFitRef の reset は clearHistorySessionState 内で行い、sessionId effect が
    // それを呼ぶ。
    expect(HISTORY_SRC).toMatch(/hasFitRef\.current\s*=\s*false/);
    expect(HISTORY_SRC).toMatch(
      /clearHistorySessionState\(\)[\s\S]*?\}\,\s*\[sessionId,\s*clearHistorySessionState\]/,
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

// =======================================================================
// Phase 1-J Codex P2: stale history data をクリアする
// =======================================================================
describe("history map — clear stale session data (Codex P2)", () => {
  it("clearHistorySessionState で meta/route/pins/truncated/error/選択を全消去する", () => {
    const fn = HISTORY_SRC.match(
      /const clearHistorySessionState\s*=\s*useCallback\([\s\S]*?\}\,\s*\[\]\s*\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/setMeta\(null\)/);
    expect(m).toMatch(/setRoutePoints\(\[\]\)/);
    expect(m).toMatch(/setPins\(\[\]\)/);
    expect(m).toMatch(/setPinsTruncated\(false\)/);
    expect(m).toMatch(/setSelectedPinId\(null\)/);
    expect(m).toMatch(/setDetailPinId\(null\)/);
    expect(m).toMatch(/setError\(null\)/);
    expect(m).toMatch(/hasFitRef\.current\s*=\s*false/);
  });

  it("loadAll 開始時に clearHistorySessionState を呼ぶ (metadata 失敗前に clear)", () => {
    // metadata fetch より前で clear している
    expect(HISTORY_SRC).toMatch(
      /clearHistorySessionState\(\);[\s\S]*?setLoading\(true\)[\s\S]*?\/api\/field-survey\/sessions\//,
    );
  });

  it("sessionId 変更時にも clearHistorySessionState を呼ぶ", () => {
    expect(HISTORY_SRC).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*clearHistorySessionState\(\);\s*\}\,\s*\[sessionId,\s*clearHistorySessionState\]\)/,
    );
  });

  it("load 世代 (loadGenerationRef) で古い fetch 結果の上書きを防ぐ", () => {
    expect(HISTORY_SRC).toMatch(/loadGenerationRef/);
    expect(HISTORY_SRC).toMatch(/const gen\s*=\s*\+\+loadGenerationRef\.current/);
    expect(HISTORY_SRC).toMatch(
      /const stale\s*=\s*\(\)\s*=>\s*!mountedRef\.current\s*\|\|\s*loadGenerationRef\.current\s*!==\s*gen/,
    );
  });

  it("metadata 403/404/malformed 後は setMeta/setRoutePoints/setPins へ進まず return する", () => {
    // metadata !ok と malformed 双方で early return (setMeta 前)
    expect(HISTORY_SRC).toMatch(/if\s*\(!metaRes\.ok\)\s*\{[\s\S]*?return;/);
    expect(HISTORY_SRC).toMatch(/if\s*\(!metaBody\?\.data\)\s*\{[\s\S]*?return;/);
  });

  it("各 await 後の guard は stale() を使う (mounted + 世代)", () => {
    // track-points / pins ループ内で stale() guard を使用
    expect(HISTORY_SRC).toMatch(/if\s*\(stale\(\)\)\s*return/);
    expect(HISTORY_SRC).not.toMatch(/if\s*\(!mountedRef\.current\)\s*return/);
  });
});

// =======================================================================
// Phase 1-J Codex P2: page fetch 失敗を fail closed にする
// =======================================================================
describe("history map — fail closed on page fetch errors (Codex P2)", () => {
  it("track-points page が non-OK なら break せず throw する", () => {
    expect(HISTORY_SRC).toMatch(/if\s*\(!tpRes\.ok\)\s*throw\s+new\s+Error/);
    expect(HISTORY_SRC).not.toMatch(/if\s*\(!tpRes\.ok\)\s*break/);
  });

  it("pins page が non-OK なら break せず throw する", () => {
    expect(HISTORY_SRC).toMatch(/if\s*\(!pinRes\.ok\)\s*throw\s+new\s+Error/);
    expect(HISTORY_SRC).not.toMatch(/if\s*\(!pinRes\.ok\)\s*break/);
  });

  it("catch は incomplete state を clear してから汎用エラーを setError する", () => {
    const fn = HISTORY_SRC.match(/catch\s*\(err\)\s*\{[\s\S]*?\}\s*finally/);
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    // abort / stale は早期 return
    expect(m).toMatch(/AbortError/);
    expect(m).toMatch(/if\s*\(stale\(\)\)\s*return/);
    // clear → setError の順
    expect(m).toMatch(
      /clearHistorySessionState\(\)[\s\S]*?setError\(/,
    );
    // 汎用文言 (座標/PII/raw response を含めない)
    expect(m).toMatch(/読み込みに失敗しました。時間をおいて/);
  });

  it("incomplete route/pins を成功表示しない (setRoutePoints/setPins はループ完了後)", () => {
    // 失敗時は throw → catch へ。setRoutePoints / setPins には到達しない。
    // ループ内に setRoutePoints / setPins を置いていないこと (途中 commit 防止)。
    const trackLoop = HISTORY_SRC.match(
      /for\s*\([\s\S]*?i\s*<\s*TRACK_PAGE_MAX[\s\S]*?\n      \}/,
    );
    expect(trackLoop?.[0]).not.toMatch(/setRoutePoints/);
    const pinLoop = HISTORY_SRC.match(
      /for\s*\([\s\S]*?i\s*<\s*PIN_PAGE_MAX[\s\S]*?\n      \}/,
    );
    expect(pinLoop?.[0]).not.toMatch(/setPins\(/);
  });

  it("truncated 警告は page 上限到達専用で HTTP failure を隠さない", () => {
    // truncated は i === PIN_PAGE_MAX - 1 でのみ true。HTTP failure は throw 経路。
    expect(HISTORY_SRC).toMatch(/i\s*===\s*PIN_PAGE_MAX\s*-\s*1\)\s*truncated\s*=\s*true/);
    // truncated が catch / error 経路で立てられていないこと
    const fn = HISTORY_SRC.match(/catch\s*\(err\)\s*\{[\s\S]*?\}\s*finally/);
    expect(fn?.[0]).not.toMatch(/setPinsTruncated\(true\)/);
  });

  it("失敗経路でも raw response / 座標 / PII / console を出さない", () => {
    expect(HISTORY_SRC).not.toMatch(/console\.\w+\(/);
    // error 文言に座標/URL/storageKey/fileName を含めない
    expect(HISTORY_SRC).not.toMatch(/setError\([^)]*(?:lat|lng|fileUrl|storageKey|fileName)/i);
  });
});

// =======================================================================
// Phase 1-J Codex P2: track route 上限超過は fail closed
// =======================================================================
describe("history map — fail closed on over-cap track routes (Codex P2)", () => {
  it("TRACK_PAGE_MAX 到達後も nextCursor が残れば over-cap を検出する", () => {
    expect(HISTORY_SRC).toMatch(/routeOverCap/);
    expect(HISTORY_SRC).toMatch(
      /i\s*===\s*TRACK_PAGE_MAX\s*-\s*1\)\s*routeOverCap\s*=\s*true/,
    );
  });

  it("over-cap 時は描画せず throw する (incomplete route を表示しない)", () => {
    // routeOverCap が true なら点を返す前に throw する
    expect(HISTORY_SRC).toMatch(
      /if\s*\(routeOverCap\)\s*throw\s+new\s+Error\("history_route_over_cap"\)/,
    );
    // 第3弾: 線とピンを同時に取りに行くため、描画は両方そろってから1か所で行う。
    // throw は「点を返す」より前=描画へは絶対に届かない。
    const at = HISTORY_SRC.indexOf('throw new Error("history_route_over_cap")');
    expect(at).toBeGreaterThan(-1);
    expect(HISTORY_SRC.indexOf("return points;")).toBeGreaterThan(at);
    // 描画は Promise.all の結果からのみ(途中の points を直接描かない)。
    expect(HISTORY_SRC).toContain("setRoutePoints(pointsResult)");
    expect(HISTORY_SRC).not.toContain("setRoutePoints(points)");
  });

  it("over-cap は pins の truncated warning と区別される (route は専用エラー文言)", () => {
    expect(HISTORY_SRC).toMatch(/history_route_over_cap/);
    expect(HISTORY_SRC).toMatch(/点数が多すぎるため/);
    // route over-cap で setPinsTruncated を使わない
    expect(HISTORY_SRC).not.toMatch(/routeOverCap[\s\S]{0,80}setPinsTruncated/);
  });

  it("catch は over-cap と一般 failure を message で区別する", () => {
    const fn = HISTORY_SRC.match(/catch\s*\(err\)\s*\{[\s\S]*?\}\s*finally/);
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/err\.message\s*===\s*"history_route_over_cap"/);
    // over-cap でない場合は汎用 load failure 文言
    expect(m).toMatch(/読み込みに失敗しました。時間をおいて/);
    // clear してから setError (incomplete route を残さない)
    expect(m).toMatch(/clearHistorySessionState\(\)[\s\S]*?setError\(/);
  });

  it("pins 上限到達は引き続き warning (truncated)、route と混同しない", () => {
    // pins は truncated 警告 (成功表示) を維持
    expect(HISTORY_SRC).toMatch(/i\s*===\s*PIN_PAGE_MAX\s*-\s*1\)\s*truncated\s*=\s*true/);
    expect(HISTORY_SRC).toMatch(/data-testid="history-pins-truncated"/);
    // pins 側は throw しない (warning 表示のまま setPins する)
    expect(HISTORY_SRC).not.toMatch(/truncated\)\s*throw/);
  });
});

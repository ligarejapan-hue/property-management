/**
 * Phase 1-F-2 位置記録 hook / UI のソース静的検証。
 *
 * 主目的:
 * - hook が watchPosition / clearWatch / unmount cleanup を持つ
 * - localStorage / sessionStorage / IndexedDB / Wake Lock を使わない
 * - console.* に lat / lng / API response 全文 / API key を出さない
 * - UI に同意文言・常時監視否定・操作 button が存在する
 * - 既存 API path を呼び、batch POST 形式を組む
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const HOOK_SRC = readSrc(
  "src/components/field-survey/use-field-survey-location-recorder.ts",
);
const CONTROLS_SRC = readSrc(
  "src/components/field-survey/location-recorder-controls.tsx",
);
const POLYLINE_SRC = readSrc(
  "src/components/field-survey/route-polyline.tsx",
);
const MAP_SRC = readSrc("src/components/field-survey/field-survey-map.tsx");
const TRIP_SRC = readSrc("src/components/field-survey/trip-controls.tsx");

describe("use-field-survey-location-recorder — geolocation lifecycle", () => {
  it("'use client' で始まる", () => {
    expect(HOOK_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("watchPosition / clearWatch を呼ぶ", () => {
    expect(HOOK_SRC).toMatch(/watchPosition\(/);
    expect(HOOK_SRC).toMatch(/clearWatch\(/);
  });

  it("watchPosition の error callback (PositionError) を持つ", () => {
    expect(HOOK_SRC).toMatch(/handlePositionError/);
    expect(HOOK_SRC).toMatch(/describeGeolocationError/);
  });

  it("unmount cleanup で clearWatch + abort する", () => {
    // useEffect の return cleanup で stopWatchingInternal が呼ばれる
    expect(HOOK_SRC).toMatch(/stopWatchingInternal/);
    expect(HOOK_SRC).toMatch(/fetchAbortRef[\s\S]*?abort\(\)/);
    expect(HOOK_SRC).toMatch(/flushAbortRef[\s\S]*?abort\(\)/);
  });

  it("active session 復元時に自動 start しない (手動 start のみ)", () => {
    // useEffect でも sessionId 変化時に watchPosition を直接呼ばない
    // (start callback の中でのみ呼ぶ)
    const startBlock = HOOK_SRC.match(/const start[\s\S]*?\}\,/);
    expect(startBlock).not.toBeNull();
    // 別の useEffect が geo.watchPosition を直接呼んでいないこと
    const all = HOOK_SRC.match(/watchPosition\(/g) ?? [];
    expect(all.length).toBe(1);
  });

  it("sessionId 変化時に常に reset する (null / non-null 直接切替に対応)", () => {
    // 旧 gating パターン if (!sessionId) { ... } は除去されていること。
    expect(HOOK_SRC).not.toMatch(/if\s*\(\s*!sessionId\s*\)\s*\{/);
    // Codex P2 fix 4: reset effect が存在し、世代 bump + stopWatch + 各 ref/state を reset
    expect(HOOK_SRC).toMatch(/Codex P2 fix 4/);
  });

  it("AbortController を fetch / flush 別に持つ", () => {
    expect(HOOK_SRC).toMatch(/fetchAbortRef/);
    expect(HOOK_SRC).toMatch(/flushAbortRef/);
  });

  it("flush 中の二重送信を inFlightFlushRef で抑止", () => {
    expect(HOOK_SRC).toMatch(/inFlightFlushRef/);
    expect(HOOK_SRC).toMatch(/shouldFlushNow/);
  });

  it("既存 track-points API path を呼ぶ", () => {
    // GET (既存 route 取得)
    expect(HOOK_SRC).toMatch(
      /\/api\/field-survey\/sessions\/\$\{encodeURIComponent\(sid\)\}\/track-points/,
    );
    // POST (batch send) と GET を同 URL pattern で書く構造
    expect(HOOK_SRC).toMatch(/method:\s*"POST"/);
    expect(HOOK_SRC).toMatch(/points:\s*snapshot/);
  });

  it("localStorage / sessionStorage / IndexedDB / Wake Lock を使わない", () => {
    expect(HOOK_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(HOOK_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(HOOK_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
    expect(HOOK_SRC).not.toMatch(/IDBDatabase|IDBObjectStore/);
    expect(HOOK_SRC).not.toMatch(/wakeLock/);
  });

  it("console.* に lat / lng / API key / response 全文 を出さない", () => {
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*apiKey/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*body/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*position/i);
  });

  it("AuditLog 系 API を UI から直接書かない", () => {
    expect(HOOK_SRC).not.toMatch(/audit/i);
  });

  it("Google Maps Timeline / Roads API を使わない", () => {
    expect(HOOK_SRC).not.toMatch(/timeline/i);
    expect(HOOK_SRC).not.toMatch(/snapToRoads|RoadsService/i);
  });

  it("固定料金 / 円表記をハードコードしない (継続ガード)", () => {
    expect(HOOK_SRC).not.toMatch(/\$\s*\d/);
    expect(HOOK_SRC).not.toMatch(/\b\d{2,3}\s*円\b/);
  });
});

describe("location-recorder-controls — UI / consent", () => {
  it("'use client' で始まる", () => {
    expect(CONTROLS_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("位置記録 開始 / 停止 button が存在する", () => {
    expect(CONTROLS_SRC).toMatch(/位置記録開始/);
    expect(CONTROLS_SRC).toMatch(/位置記録停止/);
    expect(CONTROLS_SRC).toMatch(/data-testid="location-record-start-button"/);
    expect(CONTROLS_SRC).toMatch(/data-testid="location-record-stop-button"/);
  });

  it("同意 modal に 常時監視ではない / 業務中のみ / 端末保存しない 文言がある", () => {
    expect(CONTROLS_SRC).toMatch(/常時監視ではありません/);
    expect(CONTROLS_SRC).toMatch(/業務.*巡回.*中のみ|巡回.*中のみ/);
    expect(CONTROLS_SRC).toMatch(/端末側には保存しません/);
    expect(CONTROLS_SRC).toMatch(/data-testid="location-record-consent-modal"/);
  });

  it("ブラウザを閉じると失われる注意がある", () => {
    expect(CONTROLS_SRC).toMatch(/ブラウザを閉じ/);
    expect(CONTROLS_SRC).toMatch(/失われる/);
  });

  it("UI 側でも localStorage / sessionStorage / IndexedDB / Wake Lock を使わない", () => {
    expect(CONTROLS_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(CONTROLS_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(CONTROLS_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
    expect(CONTROLS_SRC).not.toMatch(/wakeLock/);
  });

  it("UI 側でも console に lat/lng を出さない", () => {
    expect(CONTROLS_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(CONTROLS_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(CONTROLS_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });

  it("navigator.geolocation を UI 側で直接呼ばない (hook 経由)", () => {
    expect(CONTROLS_SRC).not.toMatch(/navigator\s*\.\s*geolocation/);
    expect(CONTROLS_SRC).not.toMatch(/watchPosition\s*\(/);
    expect(CONTROLS_SRC).not.toMatch(/getCurrentPosition\s*\(/);
  });
});

describe("route-polyline — current session route only", () => {
  it("'use client' で始まる", () => {
    expect(POLYLINE_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("useMap + google.maps.Polyline を使う (vis.gl は Polyline component 未提供)", () => {
    expect(POLYLINE_SRC).toMatch(/useMap/);
    expect(POLYLINE_SRC).toMatch(/google\.maps\.Polyline/);
  });

  it("unmount で polyline.setMap(null) する", () => {
    expect(POLYLINE_SRC).toMatch(/setMap\(null\)/);
  });

  it("console / Audit に座標を流さない", () => {
    expect(POLYLINE_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(POLYLINE_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(POLYLINE_SRC).not.toMatch(/audit/i);
  });
});

describe("field-survey-map.tsx — Phase 1-F-2 統合", () => {
  it("active session の有無で LocationRecorderControls を gate する", () => {
    expect(MAP_SRC).toMatch(/hasActiveSession\s*&&[\s\S]*?<LocationRecorderControls/);
  });

  it("RoutePolyline は active session がある時のみ render", () => {
    expect(MAP_SRC).toMatch(/activeSession\s*&&[\s\S]*?<RoutePolyline/);
  });

  it("TripControls に onActiveSessionChange を渡す", () => {
    expect(MAP_SRC).toMatch(/onActiveSessionChange=\{handleActiveSessionChange\}/);
  });

  // ---- 巡回終了 → 位置記録停止の明示連動 (修正1) -------------------------

  it("TripControls に onBeforeSessionEnd を渡す", () => {
    expect(MAP_SRC).toMatch(/onBeforeSessionEnd=\{handleBeforeSessionEnd\}/);
  });

  it("handleBeforeSessionEnd は recorder.stopBeforeSessionEnd を呼ぶ", () => {
    expect(MAP_SRC).toMatch(/recorder\.stopBeforeSessionEnd\(\)/);
    expect(MAP_SRC).toMatch(/const handleBeforeSessionEnd/);
  });

  // ---- pending memory points を polyline に反映 (修正2) ----------------

  it("polyline path に savedPoints + pendingPoints を結合する", () => {
    expect(MAP_SRC).toMatch(/mergePolylinePoints/);
    expect(MAP_SRC).toMatch(/recorder\.savedPoints,\s*recorder\.pendingPoints/);
  });

  it("mergePolylinePoints は sequence 重複を dedup し sequence 順に並べる", () => {
    const fn = MAP_SRC.match(/function mergePolylinePoints[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn?.[0]).toMatch(/seen\s*=\s*new\s+Set/);
    expect(fn?.[0]).toMatch(/sort/);
  });

  it("mergePolylinePoints / polyline 経路で console / lat / lng を出さない", () => {
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*pending/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*polyline/i);
  });
});

describe("trip-controls.tsx — Phase 1-F-2 巡回終了の明示連動 (修正1)", () => {
  it("onBeforeSessionEnd prop を受け取る (boolean | void 戻り値)", () => {
    // Codex P1 (chunk flush): 戻り値 false で session end PATCH を抑止できるよう
    // boolean | void を返せる signature にする。
    expect(TRIP_SRC).toMatch(
      /onBeforeSessionEnd\?:\s*\(\)\s*=>\s*Promise<boolean\s*\|\s*void>\s*\|\s*boolean\s*\|\s*void/,
    );
  });

  it("endSession 内で onBeforeSessionEnd を await してから PATCH を打つ", () => {
    // endSession 関数の冒頭 (PATCH fetch より前) で onBeforeSessionEnd を await している
    const endBlock = TRIP_SRC.match(
      /const endSession[\s\S]*?method:\s*"PATCH"/,
    );
    expect(endBlock).not.toBeNull();
    expect(endBlock?.[0]).toMatch(/await\s+onBeforeSessionEnd\(\)/);
  });

  it("onBeforeSessionEnd の throw は握り潰して PATCH を継続する", () => {
    // try { ... = await onBeforeSessionEnd() } catch { ... } のパターン
    expect(TRIP_SRC).toMatch(/await\s+onBeforeSessionEnd\(\)[\s\S]{0,80}\}\s*catch/);
  });

  it("onBeforeSessionEnd が false を返したら PATCH を打たず active に戻す", () => {
    // Codex P1: 未送信 buffer が残っている場合の data loss を抑止
    expect(TRIP_SRC).toMatch(
      /beforeOk\s*===\s*false[\s\S]*?未送信の位置情報が残っている[\s\S]*?setPhase\("active"\)[\s\S]*?return/,
    );
    // false 分岐から PATCH に到達しない構造 (return がある)
    const endBlock = TRIP_SRC.match(
      /const endSession[\s\S]*?method:\s*"PATCH"/,
    );
    const m = endBlock?.[0] ?? "";
    expect(m).toMatch(/beforeOk\s*===\s*false/);
    expect(m).toMatch(/setPhase\("active"\)/);
  });
});

describe("use-field-survey-location-recorder — pending + stopBeforeSessionEnd (修正)", () => {
  it("戻り値に pendingPoints を含める", () => {
    expect(HOOK_SRC).toMatch(/pendingPoints,/);
    expect(HOOK_SRC).toMatch(/setPendingPoints/);
  });

  it("buffer push / flush 成功で pendingPoints が同期される", () => {
    // handlePosition の push 後 / flushBuffer の success 後に setPendingPoints
    // を呼ぶ箇所がそれぞれある
    const positionBlock = HOOK_SRC.match(
      /bufferRef\.current\.push\(candidate\)[\s\S]*?\}\,\s*\[flushBuffer\]/,
    );
    expect(positionBlock).not.toBeNull();
    expect(positionBlock?.[0]).toMatch(/setPendingPoints/);
    const flushBlock = HOOK_SRC.match(
      /bufferRef\.current\s*=\s*bufferRef\.current\.filter[\s\S]*?safeSetState\(setBufferedCount[\s\S]*?safeSetState\(setPendingPoints/,
    );
    expect(flushBlock).not.toBeNull();
  });

  it("session 切替時に pendingPoints も reset する", () => {
    const resetBlock = HOOK_SRC.match(
      /setSavedPoints\(\[\]\)[\s\S]*?setPendingPoints\(\[\]\)/,
    );
    expect(resetBlock).not.toBeNull();
  });

  it("stopBeforeSessionEnd を export し watch 停止 + chunk drain を行う", () => {
    expect(HOOK_SRC).toMatch(/const stopBeforeSessionEnd/);
    // Codex P1 (chunk flush): 単発 flushBuffer ではなく flushAllBufferedChunks 経由
    expect(HOOK_SRC).toMatch(
      /stopBeforeSessionEnd[\s\S]{0,600}stopWatchingInternal\(\)[\s\S]*?flushAllBufferedChunks\(\)/,
    );
    expect(HOOK_SRC).toMatch(/return\s*\{[\s\S]*?stopBeforeSessionEnd,[\s\S]*?\}/);
  });

  it("stopBeforeSessionEnd は boolean を返し、false 時に汎用エラー文言を出す", () => {
    // Promise<boolean> の戻り値
    expect(HOOK_SRC).toMatch(
      /const stopBeforeSessionEnd\s*=\s*useCallback\(async\s*\(\)\s*:\s*Promise<boolean>/,
    );
    // 残 buffer 時: 座標を含めない汎用文言を setError、その後 idle に倒し false を返す
    expect(HOOK_SRC).toMatch(
      /!drained[\s\S]*?未送信の位置情報が残っている/,
    );
    expect(HOOK_SRC).toMatch(/return\s+drained/);
  });
});

// =======================================================================
// Codex hardening (P1/P2 — 4 fixes)
// =======================================================================

describe("Codex P1 fix 1 — wait for in-flight flush before ending", () => {
  it("flush は Promise として inFlightFlushPromiseRef で追跡される", () => {
    expect(HOOK_SRC).toMatch(/inFlightFlushPromiseRef/);
    // flushBuffer 内で work IIFE を ref に代入する pattern
    expect(HOOK_SRC).toMatch(
      /inFlightFlushPromiseRef\.current\s*=\s*work/,
    );
    // finally で null に戻す pattern (自分が登録した promise のみ)
    expect(HOOK_SRC).toMatch(
      /inFlightFlushPromiseRef\.current\s*===\s*work[\s\S]*?inFlightFlushPromiseRef\.current\s*=\s*null/,
    );
  });

  it("stopBeforeSessionEnd は flushAllBufferedChunks() 経由で in-flight 待機 + chunk drain", () => {
    // 順序: clearWatch (= stopWatchingInternal) → flushAllBufferedChunks
    // (flushAllBufferedChunks の中で in-flight await → chunk drain)
    const block = HOOK_SRC.match(
      /stopBeforeSessionEnd[\s\S]*?stopWatchingInternal\(\)[\s\S]*?await\s+flushAllBufferedChunks\(\)/,
    );
    expect(block).not.toBeNull();
  });

  it("stop() (通常停止) も flushAllBufferedChunks() 経由で in-flight + chunk drain", () => {
    const block = HOOK_SRC.match(
      /const stop\s*=\s*useCallback[\s\S]*?stopWatchingInternal\(\)[\s\S]*?await\s+flushAllBufferedChunks\(\)/,
    );
    expect(block).not.toBeNull();
  });

  it("flushAllBufferedChunks 内部で in-flight Promise を await する", () => {
    const fn = HOOK_SRC.match(
      /const flushAllBufferedChunks\s*=\s*useCallback[\s\S]*?\}\,\s*\[flushBuffer\]\s*\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/inFlightFlushPromiseRef\.current/);
    expect(m).toMatch(/await\s+inflight/);
  });

  it("inflight await の raw error は console / setError に流さない", () => {
    // try { await inflight } catch { /* swallow */ } の pattern (汎用文言のみ)
    expect(HOOK_SRC).toMatch(
      /await\s+inflight[\s\S]{0,80}\}\s*catch/,
    );
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*inflight/i);
  });
});

describe("Codex P1 fix 2 — recheck session before starting watcher", () => {
  it("start() で startSessionId / startGeneration を捕捉する", () => {
    expect(HOOK_SRC).toMatch(/const startSessionId\s*=\s*sessionIdRef\.current/);
    expect(HOOK_SRC).toMatch(
      /const startGeneration\s*=\s*recorderGenerationRef\.current/,
    );
  });

  it("fetch 完了後、watchPosition 開始前に session / generation を再確認する", () => {
    // start 関数本体: fetch 後の guard
    const startBody = HOOK_SRC.match(/const start\s*=\s*useCallback[\s\S]*?\}\)\(\);/);
    expect(startBody).not.toBeNull();
    const m = startBody?.[0] ?? "";
    expect(m).toMatch(/await\s+fetchExistingTrackPoints/);
    expect(m).toMatch(
      /sessionIdRef\.current\s*!==\s*startSessionId[\s\S]*?recorderGenerationRef\.current\s*!==\s*startGeneration/,
    );
  });

  it("watchPosition 取得後にも generation を再確認し、不一致なら clearWatch する", () => {
    // watchPosition の戻り値取得後 / watchIdRef 代入前のチェック
    const block = HOOK_SRC.match(
      /id\s*=\s*geo\.watchPosition[\s\S]*?recorderGenerationRef\.current\s*!==\s*startGeneration[\s\S]*?geo\.clearWatch\(id\)/,
    );
    expect(block).not.toBeNull();
  });

  it("stop / stopBeforeSessionEnd / sessionId effect で generation を進めて continuation を無効化", () => {
    // stop
    expect(HOOK_SRC).toMatch(
      /const stop\s*=\s*useCallback[\s\S]*?recorderGenerationRef\.current\s*\+=\s*1/,
    );
    // stopBeforeSessionEnd
    expect(HOOK_SRC).toMatch(
      /const stopBeforeSessionEnd\s*=\s*useCallback[\s\S]*?recorderGenerationRef\.current\s*\+=\s*1/,
    );
    // sessionId useEffect
    expect(HOOK_SRC).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?recorderGenerationRef\.current\s*\+=\s*1[\s\S]*?\}\,\s*\[sessionId/,
    );
  });
});

describe("Codex P1 fix 3 — do not start with sequence 0 after fetch failure", () => {
  it("fetchExistingTrackPoints は ok / lastSequence / points を返し、state を直接触らない", () => {
    // 戻り値 type に points が含まれる
    expect(HOOK_SRC).toMatch(
      /Promise<\{\s*ok:\s*boolean;\s*lastSequence:[\s\S]*?points:\s*RecorderPoint\[\];/,
    );
    // 関数本体で setSavedPoints / setError を呼ばないこと
    const fn = HOOK_SRC.match(
      /const fetchExistingTrackPoints[\s\S]*?\}\,\s*\[options\]\s*\);/,
    );
    expect(fn).not.toBeNull();
    expect(fn?.[0]).not.toMatch(/setSavedPoints\(/);
    expect(fn?.[0]).not.toMatch(/setError\(/);
    expect(fn?.[0]).not.toMatch(/safeSetState\(setError/);
  });

  it("start() は r.ok===false なら watchPosition を呼ばず、汎用エラーで idle に倒す", () => {
    const startBody = HOOK_SRC.match(/const start\s*=\s*useCallback[\s\S]*?\}\)\(\);/);
    expect(startBody).not.toBeNull();
    const m = startBody?.[0] ?? "";
    // ok===false 分岐で setError + setStatus("idle") + return
    expect(m).toMatch(
      /if\s*\(\s*!r\.ok\s*\)[\s\S]*?setError\([\s\S]*?既存の巡回ルート[\s\S]*?setStatus\("idle"\)[\s\S]*?return/,
    );
    // ok===false 分岐より前に nextSequenceRef.current を 0 にリセットしていないこと
    // (Codex P2 fix 1 で Math.max(serverNext, bufferNext) に変更されたので、
    //  ok===true 後でのみ Math.max(...) 採番をしていることをガード)
    expect(m).toMatch(
      /if\s*\(\s*!r\.ok\s*\)[\s\S]*?\}\s*[\s\S]*?nextSequenceRef\.current\s*=\s*Math\.max/,
    );
  });

  it("既存 track points fetch が失敗した経路では watchPosition を呼ばない (構造ガード)", () => {
    // fetch 結果の ok===false → watchPosition() に到達しないように return している
    const startBody = HOOK_SRC.match(/const start\s*=\s*useCallback[\s\S]*?\}\)\(\);/);
    const m = startBody?.[0] ?? "";
    // !r.ok ブロックの中で geo.watchPosition を呼ばない
    const okFalseBranch = m.match(
      /if\s*\(\s*!r\.ok\s*\)\s*\{[\s\S]*?return;\s*\}/,
    );
    expect(okFalseBranch).not.toBeNull();
    expect(okFalseBranch?.[0]).not.toMatch(/watchPosition/);
  });
});

describe("Codex P2 fix 4 — reset on any sessionId change", () => {
  // reset useEffect は `// Codex P2 fix 4:` コメントで一意に識別する。
  function extractResetEffect(): string {
    const m = HOOK_SRC.match(
      /\/\/\s*Codex P2 fix 4:[\s\S]*?useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\}\,\s*\[sessionId,\s*stopWatchingInternal\]\s*\);/,
    );
    expect(m).not.toBeNull();
    return m?.[1] ?? "";
  }

  it("sessionId effect で session に関わらず watch / buffer / pending / saved / sequence を reset", () => {
    const body = extractResetEffect();
    expect(body).toMatch(/recorderGenerationRef\.current\s*\+=\s*1/);
    expect(body).toMatch(/stopWatchingInternal\(\)/);
    expect(body).toMatch(/bufferRef\.current\s*=\s*\[\]/);
    expect(body).toMatch(/lastAcceptedRef\.current\s*=\s*null/);
    expect(body).toMatch(/nextSequenceRef\.current\s*=\s*0/);
    expect(body).toMatch(/setSavedPoints\(\[\]\)/);
    expect(body).toMatch(/setPendingPoints\(\[\]\)/);
    expect(body).toMatch(/setBufferedCount\(0\)/);
    expect(body).toMatch(/setStatus\("idle"\)/);
  });

  it("session 切替で自動 recording 開始しない (effect 内で watch を起動しない)", () => {
    const body = extractResetEffect();
    expect(body).not.toMatch(/watchPosition\(/);
    expect(body).not.toMatch(/\bgeo\.\w+\(/);
    expect(body).not.toMatch(/setStatus\("recording"\)/);
  });
});

describe("Codex P2 fix 1 — preserve sequence numbers when restarting after failed flush", () => {
  it("start() で maxSequenceFromBuffer を使い buffer 内最大も考慮する", () => {
    expect(HOOK_SRC).toMatch(/maxSequenceFromBuffer/);
    // import に含まれていること
    expect(HOOK_SRC).toMatch(
      /import\s*\{[^}]*maxSequenceFromBuffer[^}]*\}\s*from\s*["']@\/lib\/field-survey-geolocation-util["']/,
    );
  });

  it("nextSequenceRef は Math.max(serverNext, bufferNext) で採番される", () => {
    const startBody = HOOK_SRC.match(/const start\s*=\s*useCallback[\s\S]*?\}\)\(\);/);
    expect(startBody).not.toBeNull();
    const m = startBody?.[0] ?? "";
    expect(m).toMatch(/const serverNext\s*=\s*nextSequence\(r\.lastSequence\)/);
    expect(m).toMatch(
      /const bufferNext\s*=\s*nextSequence\(maxSequenceFromBuffer\(bufferRef\.current\)\)/,
    );
    expect(m).toMatch(
      /nextSequenceRef\.current\s*=\s*Math\.max\(serverNext,\s*bufferNext\)/,
    );
  });

  it("ok:true 直後に bufferRef.current を勝手に空にしていない (未送信を保持)", () => {
    const startBody = HOOK_SRC.match(/const start\s*=\s*useCallback[\s\S]*?\}\)\(\);/);
    const m = startBody?.[0] ?? "";
    // ok 後の body 内で bufferRef.current = [] していないこと
    const okBranch = m.match(/setSavedPoints\(r\.points\)[\s\S]*?setStatus\("recording"\)/);
    expect(okBranch).not.toBeNull();
    expect(okBranch?.[0]).not.toMatch(/bufferRef\.current\s*=\s*\[\]/);
    expect(okBranch?.[0]).not.toMatch(/setPendingPoints\(\[\]\)/);
  });
});

describe("Codex P2 fix 2 — do not start from truncated route history", () => {
  it("fetch loop は page cap 到達かつ nextCursor 残存で ok:false を返す", () => {
    const fn = HOOK_SRC.match(
      /const fetchExistingTrackPoints[\s\S]*?\}\,\s*\[options\]\s*\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    // for ループ脱出後に ok:true ではなく ok:false の return がある
    expect(m).toMatch(
      /for\s*\(let\s+i\s*=\s*0[\s\S]*?\}\s*[\s\S]*?return\s*\{\s*ok:\s*false[\s\S]*?lastSequence:\s*null[\s\S]*?points:\s*\[\]/,
    );
    // ループ内: nextCursor が無い時のみ ok:true を返す pattern
    expect(m).toMatch(
      /if\s*\(typeof\s+next\s*!==\s*"number"\)\s*\{[\s\S]*?return\s*\{\s*ok:\s*true,\s*lastSequence:\s*lastSeq,\s*points:\s*all/,
    );
  });

  it("truncated 時の理由がコメントで明示されている (skipDuplicates / 保存漏れ)", () => {
    expect(HOOK_SRC).toMatch(/Codex P2 fix 2/);
    expect(HOOK_SRC).toMatch(/truncated|page cap/i);
  });

  it("ok:false なら start() は watchPosition を呼ばない (既存仕様の継続)", () => {
    const startBody = HOOK_SRC.match(/const start\s*=\s*useCallback[\s\S]*?\}\)\(\);/);
    const m = startBody?.[0] ?? "";
    const okFalseBranch = m.match(/if\s*\(\s*!r\.ok\s*\)\s*\{[\s\S]*?return;\s*\}/);
    expect(okFalseBranch).not.toBeNull();
    expect(okFalseBranch?.[0]).not.toMatch(/watchPosition/);
    // 汎用エラー文言で sequence/座標を含めない
    expect(okFalseBranch?.[0]).not.toMatch(/sequence/);
    expect(okFalseBranch?.[0]).not.toMatch(/lat|lng/i);
  });
});

describe("Codex P1 — cap each flush at API batch limit (200)", () => {
  it("FIELD_SURVEY_FLUSH_API_BATCH_LIMIT を import している", () => {
    expect(HOOK_SRC).toMatch(
      /import\s*\{[^}]*FIELD_SURVEY_FLUSH_API_BATCH_LIMIT[^}]*\}\s*from\s*["']@\/lib\/field-survey-geolocation-util["']/,
    );
  });

  it("flushBuffer の snapshot が batch limit で slice されている", () => {
    // bufferRef.current.slice() で全件取らず、(0, FIELD_SURVEY_FLUSH_API_BATCH_LIMIT) で chunk 化
    // (引数が改行されていても trailing comma 有無に関わらず一致するよう許容)
    expect(HOOK_SRC).toMatch(
      /const\s+snapshot\s*=\s*bufferRef\.current\.slice\(\s*0\s*,\s*FIELD_SURVEY_FLUSH_API_BATCH_LIMIT\s*,?\s*\)/,
    );
    // 全件 slice() への regression を防ぐ (no-arg slice が残らない)
    expect(HOOK_SRC).not.toMatch(/bufferRef\.current\.slice\(\)/);
  });

  it("flushAllBufferedChunks helper が定義されている", () => {
    expect(HOOK_SRC).toMatch(/const\s+flushAllBufferedChunks\s*=\s*useCallback/);
    // Promise<boolean> を返す
    expect(HOOK_SRC).toMatch(
      /flushAllBufferedChunks\s*=\s*useCallback\(async\s*\(\)\s*:\s*Promise<boolean>/,
    );
  });

  it("flushAllBufferedChunks は進捗が無い場合 break して無限ループしない", () => {
    const fn = HOOK_SRC.match(
      /const flushAllBufferedChunks\s*=\s*useCallback[\s\S]*?\}\,\s*\[flushBuffer\]\s*\);/,
    );
    const m = fn?.[0] ?? "";
    // while ループ内で before / after を取り、進捗なしなら break
    expect(m).toMatch(/while\s*\(\s*bufferRef\.current\.length\s*>\s*0\s*\)/);
    expect(m).toMatch(/const\s+before\s*=\s*bufferRef\.current\.length/);
    expect(m).toMatch(/const\s+after\s*=\s*bufferRef\.current\.length/);
    expect(m).toMatch(/if\s*\(\s*!ok\s*\)\s*break/);
    expect(m).toMatch(/if\s*\(\s*after\s*>=\s*before\s*\)\s*break/);
  });

  it("flushAllBufferedChunks は完全排出時 true / 残あり時 false", () => {
    const fn = HOOK_SRC.match(
      /const flushAllBufferedChunks\s*=\s*useCallback[\s\S]*?\}\,\s*\[flushBuffer\]\s*\);/,
    );
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/return\s+bufferRef\.current\.length\s*===\s*0/);
  });

  it("FIELD_SURVEY_FLUSH_API_BATCH_LIMIT は 200 (server schema の .max(200) と一致)", () => {
    // util ファイル側でも検証する (実値は util test で固められるが、構造ガード)
    expect(HOOK_SRC).toMatch(/FIELD_SURVEY_FLUSH_API_BATCH_LIMIT/);
  });

  it("座標を含めない汎用エラー文言で session end PATCH を抑止する", () => {
    // 未送信 buffer が残った場合の文言
    expect(HOOK_SRC).toMatch(/未送信の位置情報が残っている/);
    // 文言そのものに lat / lng / 数値 / API status を含めないこと
    // (setError(...) の引数文字列だけを抜き出して検査)
    const errCall = HOOK_SRC.match(
      /!drained[\s\S]*?setError\(\s*"([^"]+)"/,
    );
    expect(errCall).not.toBeNull();
    const msg = errCall?.[1] ?? "";
    expect(msg).not.toMatch(/lat|lng/i);
    expect(msg).not.toMatch(/sequence/i);
    expect(msg).not.toMatch(/422|HTTP/i);
    expect(msg).not.toMatch(/\d/); // 数値 (件数 / status code 等) を含めない
  });
});

describe("Codex P1 — drain buffered points before ending idle recorder", () => {
  it("hasBufferedWork helper が buffer / inFlightFlushRef / inFlightFlushPromiseRef を見ている", () => {
    expect(HOOK_SRC).toMatch(/const\s+hasBufferedWork\s*=\s*useCallback/);
    const fn = HOOK_SRC.match(
      /const\s+hasBufferedWork\s*=\s*useCallback[\s\S]*?\}\,\s*\[\]\s*\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/bufferRef\.current\.length\s*>\s*0/);
    expect(m).toMatch(/inFlightFlushRef\.current/);
    expect(m).toMatch(/inFlightFlushPromiseRef\.current\s*!==\s*null/);
  });

  it("stopBeforeSessionEnd は idle + !hasBufferedWork() のみ早期 true を返す", () => {
    expect(HOOK_SRC).toMatch(
      /if\s*\(\s*status\s*===\s*"idle"\s*&&\s*!hasBufferedWork\(\)\s*\)\s*return\s+true/,
    );
    // 旧 pattern `if (status === "idle") return true;` (buffer 無視) が残っていないこと
    expect(HOOK_SRC).not.toMatch(
      /if\s*\(\s*status\s*===\s*"idle"\s*\)\s*return\s+true/,
    );
  });

  it("idle + buffer 残あり経路でも flushAllBufferedChunks を呼ぶ", () => {
    // stopBeforeSessionEnd body 全体で、idle 早期 return 後に
    // flushAllBufferedChunks() が呼ばれる構造であること
    const fn = HOOK_SRC.match(
      /const\s+stopBeforeSessionEnd\s*=\s*useCallback[\s\S]*?\}\,\s*\[[\s\S]*?\]\s*\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/hasBufferedWork\(\)/);
    expect(m).toMatch(/await\s+flushAllBufferedChunks\(\)/);
    // drained === false → setError + idle で false を返す
    expect(m).toMatch(/if\s*\(\s*!drained\s*\)/);
    expect(m).toMatch(/return\s+drained/);
  });

  it("idle 早期 return 時に flushAllBufferedChunks を呼ばない (no-op path)", () => {
    // 「idle + buffer 無し」のときに setError も発火しないこと
    // (位置記録停止直後で正常状態なら何も起こらない)
    const fn = HOOK_SRC.match(
      /const\s+stopBeforeSessionEnd\s*=\s*useCallback[\s\S]*?\}\,\s*\[[\s\S]*?\]\s*\);/,
    );
    const m = fn?.[0] ?? "";
    // 早期 return が flushAllBufferedChunks 呼び出しより前に書かれている
    const earlyReturnIdx = m.search(
      /status\s*===\s*"idle"\s*&&\s*!hasBufferedWork\(\)/,
    );
    const flushIdx = m.search(/await\s+flushAllBufferedChunks/);
    expect(earlyReturnIdx).toBeGreaterThanOrEqual(0);
    expect(flushIdx).toBeGreaterThan(earlyReturnIdx);
  });

  it("座標 / 内部詳細を含めない汎用エラー文言で false を返す (再ガード)", () => {
    // !drained → setError(...) → return drained
    const block = HOOK_SRC.match(
      /!drained[\s\S]*?setError\(\s*"([^"]+)"/,
    );
    expect(block).not.toBeNull();
    const msg = block?.[1] ?? "";
    expect(msg).toMatch(/未送信の位置情報が残っている/);
    expect(msg).not.toMatch(/lat|lng/i);
    expect(msg).not.toMatch(/\d/);
  });
});

describe("Codex P2 — reject over-limit GPS accuracy in normalizePosition", () => {
  it("normalizePosition は MAX 超 accuracy で undefined 化せず null を返す", () => {
    // util の挙動は別 test ファイルで担保するが、構造ガードとして hook がこの
    // 結果 (= null) を「無効な candidate として捨てる」設計を維持しているか確認。
    expect(HOOK_SRC).toMatch(/if\s*\(\s*!candidate\s*\)\s*return/);
  });

  it("hook は accuracy 不明な点だけを単独で捨てる旧パターンを使っていない", () => {
    // 旧パターン: `if (acc !== null && acc <= MAX) ? acc : undefined`
    // が hook 側に紛れ込んでいないこと (util へ集約済)
    expect(HOOK_SRC).not.toMatch(
      /FIELD_SURVEY_MAX_ACCURACY_M[\s\S]{0,40}\?\s*acc[\s\S]{0,40}:\s*undefined/,
    );
  });
});

describe("Codex hardening — privacy preservation (regression guard)", () => {
  it("inflight / generation の追加で console に lat/lng/raw response/api key を出していない", () => {
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*apiKey/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*response/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });

  it("localStorage / sessionStorage / IndexedDB を使わない (継続)", () => {
    expect(HOOK_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(HOOK_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(HOOK_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
  });

  it("Wake Lock を使わない (継続)", () => {
    expect(HOOK_SRC).not.toMatch(/wakeLock/);
  });
});

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

  it("session が消えたら強制停止する", () => {
    expect(HOOK_SRC).toMatch(/if\s*\(\s*!sessionId\s*\)/);
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
});

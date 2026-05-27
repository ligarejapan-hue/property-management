/**
 * Phase 1-F-3 現在地表示 UI / hook 拡張のソース静的検証。
 *
 * 主目的:
 * - hook が latestPositionForDisplay / lastLocationErrorForDisplay /
 *   isWaitingForFirstLocation を公開する
 * - TrackPoint 保存条件 (shouldAcceptCandidate / sequence / batch flush) を
 *   変更していない
 * - 現在地マーカーが clickable:false + setMap(null) cleanup を持ち、
 *   Map click / pin 追加モードを邪魔しない
 * - 現在地へ移動ボタンは onClick 経由のみ panTo を呼ぶ (自動 pan なし)
 * - lat / lng / raw position / API key / PII を console / UI 数値表示に出さない
 * - localStorage / sessionStorage / IndexedDB を使わない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

// コメント (JSDoc / 行コメント) を除いた実コードのみを検査するための helper。
// 「使用していない」系のアサーションが JSDoc 内の説明文に誤検知されるのを防ぐ。
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const HOOK_SRC = readSrc(
  "src/components/field-survey/use-field-survey-location-recorder.ts",
);
const STATUS_SRC = readSrc(
  "src/components/field-survey/current-location-status.tsx",
);
const STATUS_CODE = stripComments(STATUS_SRC);
const MARKER_SRC = readSrc(
  "src/components/field-survey/current-location-marker.tsx",
);
const MARKER_CODE = stripComments(MARKER_SRC);
const MAP_SRC = readSrc("src/components/field-survey/field-survey-map.tsx");
const UTIL_SRC = readSrc("src/lib/field-survey-current-location-util.ts");
const UTIL_CODE = stripComments(UTIL_SRC);

describe("use-field-survey-location-recorder — Phase 1-F-3 拡張", () => {
  it("latestPositionForDisplay state / setter を持つ", () => {
    expect(HOOK_SRC).toMatch(/latestPositionForDisplay/);
    expect(HOOK_SRC).toMatch(/setLatestPositionForDisplay/);
  });

  it("LatestPositionForDisplay 型を export している", () => {
    expect(HOOK_SRC).toMatch(/export\s+interface\s+LatestPositionForDisplay/);
  });

  it("UseLocationRecorderResult に 3 つの新規 field がある", () => {
    expect(HOOK_SRC).toMatch(
      /latestPositionForDisplay:\s*LatestPositionForDisplay\s*\|\s*null/,
    );
    expect(HOOK_SRC).toMatch(/lastLocationErrorForDisplay:\s*string\s*\|\s*null/);
    expect(HOOK_SRC).toMatch(/isWaitingForFirstLocation:\s*boolean/);
  });

  it("戻り値オブジェクトに 3 つの新規 field を含める", () => {
    const returnBlock = HOOK_SRC.match(
      /return\s*\{[\s\S]*?stopBeforeSessionEnd,[\s\S]*?\}/,
    );
    expect(returnBlock).not.toBeNull();
    const m = returnBlock?.[0] ?? "";
    expect(m).toMatch(/latestPositionForDisplay,/);
    expect(m).toMatch(/lastLocationErrorForDisplay,/);
    expect(m).toMatch(/isWaitingForFirstLocation,/);
  });

  it("isWaitingForFirstLocation は status + latestPositionForDisplay から derive", () => {
    // (status === "preparing" || status === "recording") && latestPositionForDisplay === null
    expect(HOOK_SRC).toMatch(
      /const\s+isWaitingForFirstLocation\s*=[\s\S]*?status\s*===\s*"preparing"[\s\S]*?status\s*===\s*"recording"[\s\S]*?latestPositionForDisplay\s*===\s*null/,
    );
  });

  it("handlePosition は normalizePosition 候補ごとに表示用 state を更新する (採用判定の前)", () => {
    // normalizePosition 直後 → setLatestPositionForDisplay → shouldAcceptCandidate
    expect(HOOK_SRC).toMatch(
      /normalizePosition\([\s\S]{0,200}\)[\s\S]*?setLatestPositionForDisplay\([\s\S]*?shouldAcceptCandidate/,
    );
  });

  it("handlePosition は採用成功時に lastLocationErrorForDisplay を null に戻す", () => {
    expect(HOOK_SRC).toMatch(
      /setLatestPositionForDisplay\([\s\S]*?setLastLocationErrorForDisplay\(null\)/,
    );
  });

  it("handlePositionError で lastLocationErrorForDisplay を set する", () => {
    expect(HOOK_SRC).toMatch(
      /handlePositionError[\s\S]*?describeGeolocationError\(err\)[\s\S]*?setLastLocationErrorForDisplay\(/,
    );
  });

  it("session 切替の reset effect で latestPositionForDisplay / lastLocationErrorForDisplay を null に戻す", () => {
    const m = HOOK_SRC.match(
      /\/\/\s*Codex P2 fix 4:[\s\S]*?useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\}\,\s*\[sessionId,\s*stopWatchingInternal\]\s*\);/,
    );
    expect(m).not.toBeNull();
    const body = m?.[1] ?? "";
    expect(body).toMatch(/setLatestPositionForDisplay\(null\)/);
    expect(body).toMatch(/setLastLocationErrorForDisplay\(null\)/);
  });

  it("TrackPoint 採用判定 (shouldAcceptCandidate / sequence / flush) は変更されていない", () => {
    // 既存ロジック構造の継続ガード
    expect(HOOK_SRC).toMatch(/shouldAcceptCandidate/);
    expect(HOOK_SRC).toMatch(/nextSequenceRef\.current\s*=\s*seq\s*\+\s*1/);
    expect(HOOK_SRC).toMatch(/bufferRef\.current\.push\(candidate\)/);
    expect(HOOK_SRC).toMatch(/FIELD_SURVEY_FLUSH_BATCH_SIZE/);
    // watchPosition の呼び出しは 1 箇所のまま (Phase 1-F-3 では新規 watch を追加しない)
    const all = HOOK_SRC.match(/watchPosition\(/g) ?? [];
    expect(all.length).toBe(1);
  });

  it("表示用 state 追加で localStorage / sessionStorage / IndexedDB / Wake Lock を使わない", () => {
    expect(HOOK_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(HOOK_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(HOOK_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
    expect(HOOK_SRC).not.toMatch(/wakeLock/);
  });

  it("hook に Google Maps Timeline / Roads API を使わない", () => {
    expect(HOOK_SRC).not.toMatch(/timeline/i);
    expect(HOOK_SRC).not.toMatch(/snapToRoads|RoadsService/i);
  });

  it("hook に console で lat / lng / raw position / API key / response を出さない", () => {
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*position/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*apiKey/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\([^)]*response/i);
    expect(HOOK_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });
});

describe("current-location-marker.tsx — clickable: false / cleanup", () => {
  it("'use client' で始まる", () => {
    expect(MARKER_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("useMap + google.maps.Marker を使う (vis.gl AdvancedMarker は使わない)", () => {
    expect(MARKER_SRC).toMatch(/useMap/);
    expect(MARKER_SRC).toMatch(/maps\?:\s*\{[\s\S]*?Marker\?:/);
    // AdvancedMarker を import / 直接利用しないことで pin 追加モードの map click と
    // 確実に分離する (実コード上に AdvancedMarker を含めない)。
    expect(MARKER_CODE).not.toMatch(/AdvancedMarker/);
  });

  it("clickable: false で Map click と干渉しない", () => {
    expect(MARKER_SRC).toMatch(/clickable:\s*false/);
  });

  it("unmount で marker.setMap(null) する", () => {
    expect(MARKER_SRC).toMatch(/setMap\(null\)/);
  });

  it("座標を console / Audit / Error に流さない", () => {
    expect(MARKER_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(MARKER_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(MARKER_SRC).not.toMatch(/console\.\w+\([^)]*position/i);
    // 実コード上に audit 系の関数呼び出し / import が無いこと (JSDoc 言及は許容)
    expect(MARKER_CODE).not.toMatch(/audit/i);
  });

  it("lat / lng の数値を JSX 内で文字列描画しない (marker は何も render しない)", () => {
    // return は null で UI 文字列を描画しないこと
    expect(MARKER_SRC).toMatch(/return\s+null/);
    expect(MARKER_SRC).not.toMatch(/\{lat\}/);
    expect(MARKER_SRC).not.toMatch(/\{lng\}/);
  });

  it("localStorage / sessionStorage / IndexedDB / Wake Lock を使わない", () => {
    expect(MARKER_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(MARKER_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(MARKER_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
    expect(MARKER_SRC).not.toMatch(/wakeLock/);
  });
});

describe("current-location-status.tsx — UI / pan button", () => {
  it("'use client' で始まる", () => {
    expect(STATUS_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("現在地セクション header と data-testid を持つ", () => {
    expect(STATUS_SRC).toMatch(/data-testid="current-location-section"/);
    expect(STATUS_SRC).toMatch(/現在地/);
  });

  it("「現在地へ移動」ボタンが存在し、testid と onClick を持つ", () => {
    expect(STATUS_SRC).toMatch(/data-testid="current-location-pan-button"/);
    expect(STATUS_SRC).toMatch(/現在地へ移動/);
    expect(STATUS_SRC).toMatch(/onClick=\{\s*\(\)\s*=>\s*onPanToCurrent\(\)\s*\}/);
  });

  it("latestPositionForDisplay が null なら pan ボタンは disabled", () => {
    expect(STATUS_SRC).toMatch(/disabled=\{!hasPosition\}/);
    // 早期に hasPosition を計算
    expect(STATUS_SRC).toMatch(
      /hasPosition\s*=\s*latestPositionForDisplay\s*!==\s*null/,
    );
  });

  it("自動 pan ロジック (useEffect 内で onPanToCurrent / panTo) を持たない", () => {
    // useEffect 自体を使わない (純 component) ことで自動 pan を構造的に禁止
    expect(STATUS_CODE).not.toMatch(/useEffect/);
    expect(STATUS_CODE).not.toMatch(/panTo/);
  });

  it("最終取得時刻は formatLocationTime 経由で表示する", () => {
    expect(STATUS_SRC).toMatch(/formatLocationTime/);
    expect(STATUS_SRC).toMatch(/data-testid="current-location-captured-at"/);
  });

  it("accuracy は formatAccuracyMeters 経由で表示する (整数 round)", () => {
    expect(STATUS_SRC).toMatch(/formatAccuracyMeters/);
    expect(STATUS_SRC).toMatch(/data-testid="current-location-accuracy"/);
  });

  it("低精度判定は isLowAccuracyForDisplay 経由で行い、警告 testid を持つ", () => {
    expect(STATUS_SRC).toMatch(/isLowAccuracyForDisplay/);
    expect(STATUS_SRC).toMatch(
      /data-testid="current-location-low-accuracy-warning"/,
    );
    expect(STATUS_SRC).toMatch(/低精度/);
  });

  it("取得待ち表示が存在する", () => {
    expect(STATUS_SRC).toMatch(/data-testid="current-location-waiting"/);
    expect(STATUS_SRC).toMatch(/取得|待ち/);
  });

  it("位置取得失敗時のエラーを汎用文言で出す (lat/lng を含めない)", () => {
    expect(STATUS_SRC).toMatch(/data-testid="current-location-error"/);
    // {lastLocationErrorForDisplay} を直接描画する pattern のみで、座標は出さない
    expect(STATUS_SRC).not.toMatch(/\{lat\}/);
    expect(STATUS_SRC).not.toMatch(/\{lng\}/);
    expect(STATUS_SRC).not.toMatch(/latestPositionForDisplay\.lat\b/);
    expect(STATUS_SRC).not.toMatch(/latestPositionForDisplay\.lng\b/);
  });

  it("UI 側で navigator.geolocation を直接呼ばない (hook 経由)", () => {
    expect(STATUS_CODE).not.toMatch(/navigator\s*\.\s*geolocation/);
    expect(STATUS_CODE).not.toMatch(/watchPosition\s*\(/);
    expect(STATUS_CODE).not.toMatch(/getCurrentPosition\s*\(/);
  });

  it("UI 側で console に lat / lng / position / api key を出さない", () => {
    expect(STATUS_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(STATUS_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(STATUS_SRC).not.toMatch(/console\.\w+\([^)]*position/i);
    expect(STATUS_SRC).not.toMatch(/console\.\w+\([^)]*apiKey/i);
    expect(STATUS_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });

  it("localStorage / sessionStorage / IndexedDB / Wake Lock を使わない", () => {
    expect(STATUS_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(STATUS_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(STATUS_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
    expect(STATUS_SRC).not.toMatch(/wakeLock/);
  });

  it("dangerouslySetInnerHTML を使わない", () => {
    expect(STATUS_SRC).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

describe("field-survey-map.tsx — Phase 1-F-3 統合", () => {
  it("CurrentLocationMarker / CurrentLocationStatus を import している", () => {
    expect(MAP_SRC).toMatch(
      /from\s*["']@\/components\/field-survey\/current-location-marker["']/,
    );
    expect(MAP_SRC).toMatch(
      /from\s*["']@\/components\/field-survey\/current-location-status["']/,
    );
  });

  it("現在地マーカーは recording 中かつ latestPositionForDisplay がある時のみ render", () => {
    // showCurrentLocationMarker フラグで gate されている
    expect(MAP_SRC).toMatch(/showCurrentLocationMarker/);
    expect(MAP_SRC).toMatch(
      /status\s*===\s*"recording"[\s\S]*?latestPositionForDisplay/,
    );
    expect(MAP_SRC).toMatch(
      /\{showCurrentLocationMarker[\s\S]*?<CurrentLocationMarker/,
    );
  });

  it("ControlPanel に CurrentLocationStatus を gate 付き render", () => {
    expect(MAP_SRC).toMatch(/hasActiveSession\s*&&[\s\S]*?<CurrentLocationStatus/);
  });

  it("CurrentLocationStatus に recorder の新規 field を渡す", () => {
    const block = MAP_SRC.match(
      /<CurrentLocationStatus[\s\S]*?\/>/,
    );
    expect(block).not.toBeNull();
    const m = block?.[0] ?? "";
    expect(m).toMatch(
      /latestPositionForDisplay=\{recorder\.latestPositionForDisplay\}/,
    );
    expect(m).toMatch(
      /isWaitingForFirstLocation=\{recorder\.isWaitingForFirstLocation\}/,
    );
    expect(m).toMatch(
      /lastLocationErrorForDisplay=\{recorder\.lastLocationErrorForDisplay\}/,
    );
    expect(m).toMatch(/onPanToCurrent=\{onPanToCurrent\}/);
  });

  it("MapInstanceCapture が map を state に上げ、panTo はクリック時のみ呼ばれる", () => {
    expect(MAP_SRC).toMatch(/function MapInstanceCapture/);
    // handlePanToCurrent: useCallback(() => { ... panTo({lat, lng}) ... })
    // = ボタン経由でしか呼ばれない (useEffect 経由の自動 pan が無い)
    const handler = MAP_SRC.match(
      /const handlePanToCurrent\s*=\s*useCallback\(\(\)\s*=>\s*\{[\s\S]*?\}\,\s*\[[\s\S]*?\]\s*\);/,
    );
    expect(handler).not.toBeNull();
    expect(handler?.[0]).toMatch(/panTo\(\{\s*lat:\s*pos\.lat,\s*lng:\s*pos\.lng\s*\}/);
    // panTo を useEffect の中で呼ぶ自動 pan パターンが無いことを構造ガード
    expect(MAP_SRC).not.toMatch(/useEffect\([\s\S]{0,200}panTo\(/);
  });

  it("Phase 1-G の pin 追加 map click は維持されている (handleMapClick 経路)", () => {
    expect(MAP_SRC).toMatch(/const handleMapClick/);
    expect(MAP_SRC).toMatch(/onMapClick=\{handleMapClick\}/);
    expect(MAP_SRC).toMatch(/pinAddMode/);
  });

  it("現在地マーカーで AdvancedMarker を使わない (pin click 干渉防止)", () => {
    // Map 内に追加した CurrentLocationMarker 経路で AdvancedMarker を使わない
    // (CurrentLocationMarker 自体は別ファイルで AdvancedMarker 不使用)。
    // FieldSurveyMap の既存 AdvancedMarker (property / pin) はそのまま。
    const occurrences = MAP_SRC.match(/<AdvancedMarker/g) ?? [];
    // property / pin の 2 経路のみ (Phase 1-F-3 で追加しないこと)
    expect(occurrences.length).toBeLessThanOrEqual(2);
  });

  it("map click 経路で lat / lng を console に出さない", () => {
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*position/i);
  });
});

describe("field-survey-current-location-util.ts — privacy / structure", () => {
  it("副作用 import (navigator / fetch / storage) を使わない", () => {
    expect(UTIL_CODE).not.toMatch(/navigator/);
    expect(UTIL_CODE).not.toMatch(/\bfetch\(/);
    expect(UTIL_CODE).not.toMatch(/localStorage/);
    expect(UTIL_CODE).not.toMatch(/sessionStorage/);
    expect(UTIL_CODE).not.toMatch(/indexedDB/);
  });

  it("低精度しきい値は FIELD_SURVEY_ACCURACY_WARN_M を再利用する", () => {
    expect(UTIL_SRC).toMatch(/FIELD_SURVEY_ACCURACY_WARN_M/);
    expect(UTIL_SRC).toMatch(
      /CURRENT_LOCATION_LOW_ACCURACY_THRESHOLD_M\s*=\s*FIELD_SURVEY_ACCURACY_WARN_M/,
    );
  });

  it("util に console を含めない", () => {
    expect(UTIL_SRC).not.toMatch(/console\./);
  });
});

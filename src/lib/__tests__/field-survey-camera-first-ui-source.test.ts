/**
 * カメラファースト動線のソース静的検証。
 *
 * - FieldSurveyMap への統合 (ボタン表示判定 / 地図タップ待ち / 保存後トースト)
 * - 撮影→現在地取得の callback が token / mount / session ガードを持つ
 * - PinCreateModal の initialPhotoFile 受け取り (SSR 安全な lazy init)
 * - PII 方針の継続 (座標を console / 文言に出さない)
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const MAP_SRC = readSrc("src/components/field-survey/field-survey-map.tsx");
const BUTTON_SRC = readSrc(
  "src/components/field-survey/camera-first-button.tsx",
);
const BUTTON_CODE = stripComments(BUTTON_SRC);
const BANNER_SRC = readSrc(
  "src/components/field-survey/camera-first-banner.tsx",
);
const BANNER_CODE = stripComments(BANNER_SRC);
const MODAL_SRC = readSrc("src/components/field-survey/pin-create-modal.tsx");
const MODAL_CODE = stripComments(MODAL_SRC);
const LIB_SRC = readSrc("src/lib/field-survey-camera-first.ts");
const LIB_CODE = stripComments(LIB_SRC);

describe("field-survey-camera-first.ts — 純関数 / 副作用なし", () => {
  it("navigator / fetch / storage / console を使わない", () => {
    expect(LIB_CODE).not.toMatch(/navigator/);
    expect(LIB_CODE).not.toMatch(/\bfetch\(/);
    expect(LIB_CODE).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
    expect(LIB_CODE).not.toMatch(/console\./);
  });
});

describe("camera-first-button.tsx — 撮影ボタン", () => {
  it("'use client' で始まる", () => {
    expect(BUTTON_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("input は accept=image/* + capture=environment (カメラ直起動)", () => {
    expect(BUTTON_SRC).toMatch(/accept="image\/\*"/);
    expect(BUTTON_SRC).toMatch(/capture="environment"/);
  });

  it("同じ写真の撮り直しでも change が発火するよう input.value をリセットする", () => {
    expect(BUTTON_CODE).toMatch(/\.value\s*=\s*""/);
  });

  it("file が取れた時のみ onPhotoCaptured を呼ぶ", () => {
    expect(BUTTON_CODE).toMatch(/if\s*\(\s*file\s*\)\s*\{?\s*onPhotoCaptured\(file\)/);
  });

  it("座標 / File 内容を console に出さない・storage を使わない", () => {
    expect(BUTTON_CODE).not.toMatch(/console\./);
    expect(BUTTON_CODE).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
  });
});

describe("camera-first-banner.tsx — 位置指定待ち banner", () => {
  it("'use client' で始まり role=status を持つ", () => {
    expect(BANNER_SRC.trim().startsWith('"use client"')).toBe(true);
    expect(BANNER_SRC).toMatch(/role="status"/);
  });

  it("ダークモード配色を持つ (dark: variant)", () => {
    expect(BANNER_SRC).toMatch(/dark:/);
  });

  it("console / storage を使わない", () => {
    expect(BANNER_CODE).not.toMatch(/console\./);
    expect(BANNER_CODE).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
  });
});

describe("field-survey-map.tsx — カメラファースト統合", () => {
  it("CameraFirstButton / CameraFirstBanner を import している", () => {
    expect(MAP_SRC).toMatch(
      /from\s*["']@\/components\/field-survey\/camera-first-button["']/,
    );
    expect(MAP_SRC).toMatch(
      /from\s*["']@\/components\/field-survey\/camera-first-banner["']/,
    );
  });

  it("表示判定は cameraFirstButtonState (純関数) 経由", () => {
    expect(MAP_SRC).toMatch(/cameraFirstButtonState\(\{/);
    expect(MAP_SRC).toMatch(/\.visible\s*&&[\s\S]{0,200}<CameraFirstButton/);
  });

  it("モバイルの表示切替パネル展開中は FAB / banner を出さない (タップ遮蔽防止)", () => {
    expect(MAP_SRC).toMatch(/cameraButton\.visible\s*&&\s*!panelOpen/);
    expect(MAP_SRC).toMatch(
      /"awaiting-map-tap"\s*&&\s*!panelOpen[\s\S]{0,120}<CameraFirstBanner/,
    );
    // パネル開閉 state は親管理 (ControlPanel は props で受ける)
    expect(MAP_SRC).toMatch(/panelOpen=\{panelOpen\}/);
    expect(MAP_SRC).toMatch(/onTogglePanelOpen/);
  });

  it("撮影 callback は mount / token / session の 3 ガードを持つ (現在地を使う と同型)", () => {
    // 終端は依存配列の "]," まで (関数単体に正しくスコープする)
    const handler = MAP_SRC.match(
      /const handleCameraPhotoCaptured\s*=\s*useCallback[\s\S]*?\}\,\s*\[[\s\S]*?\],?\s*\);/,
    );
    expect(handler).not.toBeNull();
    const m = handler?.[0] ?? "";
    expect(m).toMatch(/fsMapMountedRef\.current/);
    expect(m).toMatch(/currentLocationRequestIdRef\.current\s*!==\s*requestId/);
    expect(m).toMatch(/activeSessionIdRef\.current\s*!==\s*requestSessionId/);
    // 変換は純関数経由 (raw position を直接 setState しない)
    expect(m).toMatch(/cameraFirstCandidateFromPosition\(/);
    // フォールバック文言も純関数経由
    expect(m).toMatch(/cameraFirstFallbackMessage\(/);
    // watchPosition は使わない (単発取得のみ)
    expect(m).not.toMatch(/watchPosition/);
  });

  it("token 無効化で握り潰された遅延 callback は最新カメラ要求なら後始末する (locating 固着防止)", () => {
    const handler = MAP_SRC.match(
      /const handleCameraPhotoCaptured\s*=\s*useCallback[\s\S]*?\}\,\s*\[[\s\S]*?\],?\s*\);/,
    );
    expect(handler).not.toBeNull();
    const m = handler?.[0] ?? "";
    // 成功・失敗の両 callback に cameraRequestIdRef 照合付きの後始末がある
    const cleanups = m.match(/cameraRequestIdRef\.current\s*===\s*requestId/g) ?? [];
    expect(cleanups.length).toBeGreaterThanOrEqual(2);
    // modal 競合ガードは 捕捉時 + 成功 + 失敗 の 3 箇所 (error 側も非対称にしない)
    const modalGuards = m.match(/createCandidateOpenRef\.current/g) ?? [];
    expect(modalGuards.length).toBeGreaterThanOrEqual(3);
    // token 発行時に最新カメラ要求として記録する
    expect(m).toMatch(/cameraRequestIdRef\.current\s*=\s*requestId/);
  });

  it("地図タップ待ち (awaiting-map-tap) はピン追加モードより先に処理される", () => {
    const handler = MAP_SRC.match(
      /const handleMapClick\s*=\s*useCallback[\s\S]*?\}\,\s*\[[\s\S]*?\],?\s*\);/,
    );
    expect(handler).not.toBeNull();
    const m = handler?.[0] ?? "";
    // awaiting-map-tap 分岐が pinAddMode ガードより前にある
    const awaitingIdx = m.indexOf('"awaiting-map-tap"');
    const pinModeIdx = m.indexOf("!pinAddMode");
    expect(awaitingIdx).toBeGreaterThan(-1);
    expect(pinModeIdx).toBeGreaterThan(-1);
    expect(awaitingIdx).toBeLessThan(pinModeIdx);
    // 通常経路で modal を開く際、撮影の現在地取得中ならカメラ側を同期破棄する
    // (共有 token bump による "locating" 固着の根本予防)
    expect(m).toMatch(
      /cameraFirstPhase\s*===\s*"locating"\s*\)\s*resetCameraFirst\(\)/,
    );
  });

  it("map click listener はピン追加モードまたは地図タップ待ちで有効化される", () => {
    expect(MAP_SRC).toMatch(
      /captureMapClick=\{pinAddMode\s*\|\|\s*cameraFirstPhase\s*===\s*"awaiting-map-tap"\}/,
    );
    // MapDataLayer 側は captureMapClick で listener を gate
    expect(MAP_SRC).toMatch(/if\s*\(\s*!captureMapClick\s*\)\s*return/);
  });

  it("カメラファースト由来の保存完了は詳細パネルを開かずトーストを出す", () => {
    const finalize = MAP_SRC.match(
      /const finalizePinCreate\s*=\s*useCallback[\s\S]*?\}\,\s*\[[\s\S]*?\],?\s*\);/,
    );
    expect(finalize).not.toBeNull();
    const m = finalize?.[0] ?? "";
    // createdFromCameraRef が true の分岐で toast を出して early return
    expect(m).toMatch(
      /createdFromCameraRef\.current[\s\S]*?setCameraSavedNotice\(true\)[\s\S]*?return/,
    );
    // その分岐の後に従来どおり detail panel を開く
    expect(m).toMatch(/setDetailPinId\(pinId\)/);
    // カメラ由来の保存ではユーザーが明示 ON にした pin 追加モードを解除しない
    // (setPinAddMode(false) はカメラ分岐 early return の後 = 地図タップ経路のみ)
    const cameraIdx = m.indexOf("createdFromCameraRef.current");
    const modeOffIdx = m.indexOf("setPinAddMode(false)");
    expect(cameraIdx).toBeGreaterThan(-1);
    expect(modeOffIdx).toBeGreaterThan(cameraIdx);
  });

  it("保存完了トーストは 4 秒で自動で消える (unmount ガード付き)", () => {
    expect(MAP_SRC).toMatch(/setTimeout\([\s\S]{0,200}setCameraSavedNotice\(false\)/);
    expect(MAP_SRC).toMatch(/clearTimeout\(/);
  });

  it("modal には initialPhotoFile として撮影済み写真を渡す", () => {
    expect(MAP_SRC).toMatch(
      /initialPhotoFile=\{createCandidate\.cameraPhoto\s*\?\?\s*null\}/,
    );
  });

  it("session 切替 (id 変化) でカメラファースト状態をリセットする (イベント駆動)", () => {
    // effect での同期 setState を避け、TripControls からの session 通知 callback
    // 内で前回 id と比較して reset する。
    const handler = MAP_SRC.match(
      /const handleActiveSessionChange\s*=\s*useCallback\([\s\S]*?\[resetCameraFirst\],?\s*\);/,
    );
    expect(handler).not.toBeNull();
    const m = handler?.[0] ?? "";
    expect(m).toMatch(/prevActiveSessionIdRef\.current\s*!==\s*nextId/);
    expect(m).toMatch(/resetCameraFirst\(\)/);
    expect(m).toMatch(/setActiveSession\(s\)/);
    // reset は token bump + 写真破棄 + phase/notice 初期化を行う
    const reset = MAP_SRC.match(
      /const resetCameraFirst\s*=\s*useCallback\([\s\S]*?\}\,\s*\[\]\s*\);/,
    );
    expect(reset).not.toBeNull();
    const r = reset?.[0] ?? "";
    expect(r).toMatch(/currentLocationRequestIdRef\.current\s*\+=\s*1/);
    expect(r).toMatch(/cameraPhotoFileRef\.current\s*=\s*null/);
    expect(r).toMatch(/setCameraFirstPhase\("idle"\)/);
  });

  it("banner は active session かつ awaiting-map-tap のときのみ render", () => {
    expect(MAP_SRC).toMatch(
      /activeSession\s*&&\s*cameraFirstPhase\s*===\s*"awaiting-map-tap"\s*&&[\s\S]{0,120}<CameraFirstBanner/,
    );
  });
});

describe("pin-create-modal.tsx — initialPhotoFile 受け取り", () => {
  it("initialPhotoFile prop (optional) を持つ", () => {
    expect(MODAL_SRC).toMatch(/initialPhotoFile\?:\s*File\s*\|\s*null/);
  });

  it("photoFile の初期値に initialPhotoFile を使う", () => {
    expect(MODAL_SRC).toMatch(
      /useState<File\s*\|\s*null>\(\s*initialPhotoFile\s*\?\?\s*null\s*\)/,
    );
  });

  it("preview の objectURL は render 外 (親のイベントハンドラ) で生成し prop で受ける", () => {
    // modal 側は render 中に createObjectURL を呼ばない (SSR 安全 + StrictMode
    // の initializer 二重実行でもリークしない + react-hooks/refs 違反なし)。
    expect(MODAL_SRC).toMatch(/initialPhotoPreviewUrl\?:\s*string\s*\|\s*null/);
    expect(MODAL_SRC).toMatch(
      /useState<string\s*\|\s*null>\(\s*initialPhotoPreviewUrl\s*\?\?\s*null,?\s*\)/,
    );
    // useState initializer 内で createObjectURL を呼ばない (コメント除外で判定)
    expect(MODAL_CODE).not.toMatch(/useState[\s\S]{0,200}?createObjectURL/);
    // 親はカメラ candidate 生成時 (イベントハンドラ内) に preview URL も作る
    // (現在地成功 + 地図タップ待ちの 2 経路)
    const gen =
      MAP_SRC.match(
        /cameraPhotoPreviewUrl:\s*photo\s*\?\s*URL\.createObjectURL\(photo\)/g,
      ) ?? [];
    expect(gen.length).toBeGreaterThanOrEqual(2);
    expect(MAP_SRC).toMatch(
      /initialPhotoPreviewUrl=\{createCandidate\.cameraPhotoPreviewUrl\s*\?\?\s*null\}/,
    );
  });

  it("objectURL の unmount revoke は維持されている", () => {
    expect(MODAL_SRC).toMatch(/URL\.revokeObjectURL\(photoPreviewUrl\)/);
  });
});

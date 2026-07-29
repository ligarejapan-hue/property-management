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

  // ⚠2026-07-29: 撮影は GPS を待たなくなった（位置は地図タップで決める）ので、
  // 遅延 callback の 3 ガードは対象そのものが無い。代わりに「同期2手だけ」を固定する。
  it("撮影は同期で2手だけ（写真を保持→タップ待ちへ）", () => {
    const fn = MAP_SRC.match(
      /const handleCameraPhotoCaptured = useCallback\([\s\S]*?\n  \}, \[\]\);/,
    )?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).not.toMatch(/await |\.then\(|getCurrentPosition/);
    expect(fn.indexOf("cameraPhotoFileRef.current = file")).toBeLessThan(
      fn.indexOf('setCameraFirstPhase("awaiting-map-tap")'),
    );
  });

  it("作成モーダルが開いている間は撮影を二重に始めない", () => {
    const fn = MAP_SRC.match(
      /const handleCameraPhotoCaptured = useCallback\([\s\S]*?\n  \}, \[\]\);/,
    )?.[0] ?? "";
    expect(fn).toContain("createCandidateOpenRef.current");
  });

  it("地図タップはタップ待ちの時だけ受け付ける（写真なしのピンを作らない）", () => {
    const m = MAP_SRC.match(/const handleMapClick = useCallback\([\s\S]*?\n  \);/)?.[0] ?? "";
    expect(m).not.toBe("");
    expect(m).toContain('if (cameraFirstPhase !== "awaiting-map-tap") return;');
    expect(m).not.toMatch(/pinAddMode/);
  });

  it("map click listener はタップ待ちの時だけ有効化される", () => {
    expect(MAP_SRC).toMatch(
      /captureMapClick=\{cameraFirstPhase === "awaiting-map-tap"\}/,
    );
  });

  it("カメラファースト由来の保存完了は詳細パネルを開かずトーストを出す", () => {
    const finalize = MAP_SRC.match(
      /const finalizePinCreate\s*=\s*useCallback[\s\S]*?\}\,\s*\[[\s\S]*?\],?\s*\);/,
    );
    expect(finalize).not.toBeNull();
    const m = finalize?.[0] ?? "";
    // カメラ由来 (fromCamera) の分岐で toast を出して early return
    // (連続ピンモード導入で「写真付き保存」全般と統合。詳細は
    //  field-survey-pin-continuity-source.test.ts が固定)
    expect(m).toMatch(
      /createdFromCameraRef\.current[\s\S]*?setSavedToastPinId\(pinId\)[\s\S]*?return/,
    );
    // 写真なし保存は従来どおり detail panel を開く
    expect(m).toMatch(/setDetailPinId\(pinId\)/);
  });

  it("保存完了トーストは 4 秒で自動で消える (unmount ガード付き)", () => {
    expect(MAP_SRC).toMatch(/setTimeout\([\s\S]{0,200}setSavedToastPinId\(null\)/);
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
      /const handleActiveSessionChange\s*=\s*useCallback\([\s\S]*?\[resetCameraFirst[^\]]*\],?\s*\);/,
    );
    expect(handler).not.toBeNull();
    const m = handler?.[0] ?? "";
    expect(m).toMatch(/const prevId\s*=\s*prevActiveSessionIdRef\.current/);
    expect(m).toMatch(/prevId\s*!==\s*nextId/);
    expect(m).toMatch(/resetCameraFirst\(\)/);
    expect(m).toMatch(/setActiveSession\(s\)/);
    // reset は写真破棄 + phase 初期化（位置取得は無くなったので token bump も無い）
    const reset = MAP_SRC.match(
      /const resetCameraFirst\s*=\s*useCallback\([\s\S]*?\}\,\s*\[\]\s*\);/,
    );
    expect(reset).not.toBeNull();
    const r = reset?.[0] ?? "";
    expect(r).not.toMatch(/currentLocationRequestIdRef/);
    expect(r).toMatch(/cameraPhotoFileRef\.current\s*=\s*null/);
    expect(r).toMatch(/setCameraFirstPhase\("idle"\)/);
    // ⚠2026-07-29: 遅延 callback の照合 ID は不要になった。撮影が GPS を
    // 待たなくなり、後から届く callback そのものが存在しないため。
    expect(r).not.toMatch(/cameraRequestIdRef/);
  });

  it("banner は awaiting-map-tap のときのみ render (巡回外の撮影でも出す)", () => {
    // 巡回なし撮影 (quick_capture) では activeSession が無い状態で GPS 失敗
    // フォールバックに入る。巡回を条件にすると場所指定の案内が出ず操作が詰む。
    expect(MAP_SRC).toMatch(
      /cameraFirstPhase\s*===\s*"awaiting-map-tap"\s*&&\s*!panelOpen\s*&&[\s\S]{0,120}<CameraFirstBanner/,
    );
    expect(MAP_SRC).not.toMatch(
      /\{activeSession\s*&&\s*cameraFirstPhase\s*===\s*"awaiting-map-tap"/,
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
    // 生成経路は地図タップの1本だけ（現在地からの自動配置は廃止）
    const gen =
      MAP_SRC.match(
        /cameraPhotoPreviewUrl:\s*photo\s*\?\s*URL\.createObjectURL\(photo\)/g,
      ) ?? [];
    expect(gen.length).toBe(1);
    expect(MAP_SRC).toMatch(
      /initialPhotoPreviewUrl=\{createCandidate\.cameraPhotoPreviewUrl\s*\?\?\s*null\}/,
    );
  });

  it("objectURL の unmount revoke は維持されている", () => {
    expect(MODAL_SRC).toMatch(/URL\.revokeObjectURL\(photoPreviewUrl\)/);
  });
});

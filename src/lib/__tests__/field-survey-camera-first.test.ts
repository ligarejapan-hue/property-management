/**
 * 撮影→ピン登録 動線の純ロジック検証。
 *
 * ⚠2026-07-29: 位置を必ず地図タップで決める方針に変えたため、
 * `cameraFirstCandidateFromPosition`（GPS→座標）と
 * `cameraFirstFallbackMessage`（取得失敗時の案内）は廃止した。
 * それぞれの表明のうち残すべきもの（座標を文言に出さない・権限 tristate）は
 * `field-survey-pin-tap-source.test.ts` と下の describe が引き継いでいる。
 */
import { describe, it, expect } from "vitest";
import {
  cameraFirstButtonState,
  type CameraFirstPhase,
} from "@/lib/field-survey-camera-first";

describe("cameraFirstButtonState", () => {
  const base = {
    hasActiveSession: true,
    canWrite: true as boolean | null,
    phase: "idle" as CameraFirstPhase,
    modalOpen: false,
  };

  it("巡回中 + 権限あり + idle → 表示・有効", () => {
    expect(cameraFirstButtonState(base)).toEqual({
      visible: true,
      disabled: false,
    });
  });

  it("巡回 session が無ければ非表示", () => {
    expect(
      cameraFirstButtonState({ ...base, hasActiveSession: false }).visible,
    ).toBe(false);
  });

  it("作成 modal 表示中は非表示 (二重起動防止)", () => {
    expect(cameraFirstButtonState({ ...base, modalOpen: true }).visible).toBe(
      false,
    );
  });

  it("地図タップ待ち (awaiting-map-tap) 中は非表示 (banner に譲る)", () => {
    expect(
      cameraFirstButtonState({ ...base, phase: "awaiting-map-tap" }).visible,
    ).toBe(false);
  });


  it("権限なしが確定 (canWrite=false) なら表示のまま無効化 (PinAddModeToggle と同方針)", () => {
    expect(cameraFirstButtonState({ ...base, canWrite: false })).toEqual({
      visible: true,
      disabled: true,
    });
  });

  it("権限判定不能 (canWrite=null) は有効のまま (API 403 委譲)", () => {
    expect(cameraFirstButtonState({ ...base, canWrite: null })).toEqual({
      visible: true,
      disabled: false,
    });
  });
});

/**
 * カメラファースト(撮影→自動ピン)動線の純ロジック検証。
 *
 * - cameraFirstCandidateFromPosition: geolocation raw position → 候補座標の安全変換
 * - cameraFirstFallbackMessage: 位置取得不可時の案内文(地図タップへの誘導を必ず含む)
 * - cameraFirstButtonState: カメラボタンの表示/無効判定(巡回中のみ・権限 tristate)
 */
import { describe, it, expect } from "vitest";
import {
  cameraFirstCandidateFromPosition,
  cameraFirstFallbackMessage,
  cameraFirstButtonState,
  type CameraFirstPhase,
} from "@/lib/field-survey-camera-first";

describe("cameraFirstCandidateFromPosition", () => {
  it("有効な座標 + accuracy を候補に変換する", () => {
    const c = cameraFirstCandidateFromPosition({
      coords: { latitude: 35.68, longitude: 139.76, accuracy: 12.5 },
    });
    expect(c).toEqual({ lat: 35.68, lng: 139.76, accuracy: 12.5 });
  });

  it("accuracy が数値でない / 非有限なら accuracy を undefined にする", () => {
    const c1 = cameraFirstCandidateFromPosition({
      coords: { latitude: 35.68, longitude: 139.76, accuracy: Number.NaN },
    });
    expect(c1).toEqual({ lat: 35.68, lng: 139.76, accuracy: undefined });
    const c2 = cameraFirstCandidateFromPosition({
      coords: { latitude: 35.68, longitude: 139.76 },
    });
    expect(c2).toEqual({ lat: 35.68, lng: 139.76, accuracy: undefined });
  });

  it("lat / lng が欠損・非数値・非有限なら null", () => {
    expect(cameraFirstCandidateFromPosition(null)).toBeNull();
    expect(cameraFirstCandidateFromPosition({})).toBeNull();
    expect(
      cameraFirstCandidateFromPosition({ coords: { latitude: 35.68 } }),
    ).toBeNull();
    expect(
      cameraFirstCandidateFromPosition({
        coords: { latitude: "35.68", longitude: 139.76 },
      }),
    ).toBeNull();
    expect(
      cameraFirstCandidateFromPosition({
        coords: { latitude: Number.POSITIVE_INFINITY, longitude: 139.76 },
      }),
    ).toBeNull();
    expect(
      cameraFirstCandidateFromPosition({
        coords: { latitude: Number.NaN, longitude: 139.76 },
      }),
    ).toBeNull();
  });
});

describe("cameraFirstFallbackMessage", () => {
  it("すべての文言が地図タップへの誘導を含む", () => {
    for (const code of [null, 1, 3, 2, 99]) {
      expect(cameraFirstFallbackMessage(code)).toMatch(/地図をタップ/);
    }
  });

  it("code=1 (拒否) は位置情報の許可に言及する", () => {
    expect(cameraFirstFallbackMessage(1)).toMatch(/位置情報/);
    expect(cameraFirstFallbackMessage(1)).toMatch(/許可|拒否/);
  });

  it("code=3 (タイムアウト) はタイムアウトに言及する", () => {
    expect(cameraFirstFallbackMessage(3)).toMatch(/タイムアウト/);
  });

  it("code=null / その他は汎用文言 (現在地が取得できない旨)", () => {
    expect(cameraFirstFallbackMessage(null)).toMatch(/現在地/);
    expect(cameraFirstFallbackMessage(2)).toMatch(/現在地/);
  });

  it("文言に座標や技術用語 (geolocation / secure context) を含めない", () => {
    for (const code of [null, 1, 3, 2]) {
      const m = cameraFirstFallbackMessage(code);
      expect(m).not.toMatch(/geolocation/i);
      expect(m).not.toMatch(/secure\s*context/i);
      expect(m).not.toMatch(/session/i);
    }
  });
});

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

  it("現在地取得中 (locating) は表示のまま無効化", () => {
    expect(cameraFirstButtonState({ ...base, phase: "locating" })).toEqual({
      visible: true,
      disabled: true,
    });
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

/**
 * 位置記録の同意記録 (端末ローカル)。
 *
 * 業務判断 (2026-07-29): 同意文は**初回だけ**出す。巡回のたびに出すと
 * 毎日の業務で邪魔になるため。ただし従業員の位置を記録する機能なので
 * 「一度も知らせない」にはしない。
 *
 * ⚠localStorage は SSR に無く、Safari のプライベートモードでは
 * 参照・書込の両方が例外を投げることがある。**同意の記録に失敗しても
 * 業務を止めない** (最悪もう一度同意文が出るだけ) 設計を固定する。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIELD_SURVEY_LOCATION_CONSENT_KEY,
  hasLocationConsent,
  markLocationConsent,
} from "@/lib/field-survey-location-consent";

type Store = { getItem: unknown; setItem: unknown };

function installStorage(impl: Store) {
  Object.defineProperty(globalThis, "localStorage", {
    value: impl,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, "localStorage");
  vi.restoreAllMocks();
});

describe("field-survey-location-consent", () => {
  it("未同意なら false、markLocationConsent 後は true", () => {
    const map = new Map<string, string>();
    installStorage({
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    });

    expect(hasLocationConsent()).toBe(false);
    markLocationConsent();
    expect(hasLocationConsent()).toBe(true);
    expect(map.get(FIELD_SURVEY_LOCATION_CONSENT_KEY)).toBeTruthy();
  });

  it("localStorage が無い環境 (SSR) では false を返し、書込も落ちない", () => {
    // globalThis.localStorage 未定義のまま呼ぶ
    expect(hasLocationConsent()).toBe(false);
    expect(() => markLocationConsent()).not.toThrow();
  });

  it("getItem が例外を投げても false を返す (プライベートモード)", () => {
    installStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    });
    expect(hasLocationConsent()).toBe(false);
  });

  it("setItem が例外を投げても業務を止めない", () => {
    installStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => markLocationConsent()).not.toThrow();
    // 記録できなかった = 次回もう一度同意文が出る (fail-safe 側に倒す)
    expect(hasLocationConsent()).toBe(false);
  });

  it("保存する値に個人情報・座標を含めない (印だけ)", () => {
    const map = new Map<string, string>();
    installStorage({
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    });
    markLocationConsent();
    const stored = map.get(FIELD_SURVEY_LOCATION_CONSENT_KEY) ?? "";
    // 数値の羅列 (座標・ID らしきもの) を書かない
    expect(stored).toMatch(/^[a-z0-9]+$/i);
    expect(stored.length).toBeLessThanOrEqual(8);
  });

  it("キーは版を持つ (同意文を書き換えたら取り直せる)", () => {
    expect(FIELD_SURVEY_LOCATION_CONSENT_KEY).toMatch(/v\d+$/);
  });
});

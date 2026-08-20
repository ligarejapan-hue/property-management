import { describe, it, expect } from "vitest";
import {
  isSaleDmPrintReady,
  missingSaleDmPrintRequirements,
} from "@/lib/sale-dm-letter/print-ready";

/**
 * 「売却DMを作成して印刷できる前提が揃っているか」の判定規則。
 *
 * ⚠なぜ1本化するか: 実績91で**AI直結の生成を廃止**したあとも、設定画面だけが
 *   「AI種別＋APIキー」を要求し続け、**使えるのに「使えません」と表示**していた
 *   （管理者が不要な有料API契約に進みかねない）。規則を画面とサーバーで別々に
 *   書いていたことが原因なので、判定はこの純関数だけに置く。
 * ⚠郵送QRの追跡URLと遷移先LPは、**郵送先で機能するために絶対URLが必須**
 *   （非空なだけでは足りない＝サーバーは 503 になる）。
 */
const ok = {
  trackingBaseUrl: "https://example.com",
  lpUrl: "https://example.com/lp",
  senderName: "リガーレ",
  senderContact: "03-0000-0000",
};

describe("isSaleDmPrintReady", () => {
  it("追跡URL・LP URL・差出人名・連絡先の4つが揃えば true", () => {
    expect(isSaleDmPrintReady(ok)).toBe(true);
  });

  it("⚠AIの種類・APIキーは条件に入らない（4つだけで true になる）", () => {
    // 型の上でも受け取らない。ここでは「4つだけで揃う」ことを実測して固定する。
    expect(Object.keys(ok)).toHaveLength(4);
    expect(isSaleDmPrintReady(ok)).toBe(true);
  });

  it("追跡URLが相対（絶対URLでない）なら false", () => {
    expect(isSaleDmPrintReady({ ...ok, trackingBaseUrl: "example.com" })).toBe(false);
    expect(isSaleDmPrintReady({ ...ok, trackingBaseUrl: "/t" })).toBe(false);
  });

  it("LP URL が http(s) でなければ false", () => {
    expect(isSaleDmPrintReady({ ...ok, lpUrl: "ftp://example.com" })).toBe(false);
  });

  it("差出人名・連絡先が空白のみなら false", () => {
    expect(isSaleDmPrintReady({ ...ok, senderName: "  " })).toBe(false);
    expect(isSaleDmPrintReady({ ...ok, senderContact: "" })).toBe(false);
  });

  it("未設定・null でも落ちない", () => {
    expect(isSaleDmPrintReady({})).toBe(false);
    expect(isSaleDmPrintReady({ trackingBaseUrl: null, lpUrl: null })).toBe(false);
  });
});

describe("missingSaleDmPrintRequirements（画面の案内文の唯一の出所）", () => {
  it("揃っていれば空", () => {
    expect(missingSaleDmPrintRequirements(ok)).toEqual([]);
  });

  it("足りないものだけを日本語で返す", () => {
    expect(missingSaleDmPrintRequirements({ ...ok, lpUrl: "" })).toEqual(["既定LP URL"]);
    expect(
      missingSaleDmPrintRequirements({ trackingBaseUrl: "", lpUrl: "", senderName: "", senderContact: "" }),
    ).toEqual(["追跡URL", "既定LP URL", "差出人名", "差出人の連絡先"]);
  });

  it("⚠AI種別・APIキーは不足として挙げない（廃止済みのため）", () => {
    expect(missingSaleDmPrintRequirements({}).join("")).not.toContain("API");
    expect(missingSaleDmPrintRequirements({}).join("")).not.toContain("AI");
  });
});

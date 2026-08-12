/**
 * 現住所を書くときの「ペアの規則」。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §6.1 / §6.1.1
 *
 * ## 規則
 * - `currentAddress` を書き換える処理は、**同じ操作で `currentZip` も決める**。
 *   対になる郵便番号が渡ってこなければ **`currentZip` を null にする**（古い番号を残さない）。
 * - **`currentZip` だけの更新はできない**（対になる住所が無いため）。
 *
 * ## なぜ要るのか
 * 部分更新の仕組みは「渡された項目だけ」を反映する。住所だけ送ると古い郵便番号が残り、
 * 宛先の解決がその**ズレたペア**を採用して「新しい住所に古い郵便番号」を刷った郵便物ができる。
 * 逆に郵便番号だけ送ると、既存の住所に**無関係な番号**が付く。
 *
 * ⚠ 暗黙の「郵便番号を空にする」も **郵便番号への書き込み** なので、
 * 呼び出し側は `owner_zip` の書込権限を確認する（§6.1.1）。
 */
import { describe, it, expect } from "vitest";
import { resolveCurrentAddressWrite } from "@/lib/owner-current-address-write";

describe("resolveCurrentAddressWrite — 住所と郵便番号を必ずペアで扱う", () => {
  it("どちらも送られていなければ何もしない", () => {
    const r = resolveCurrentAddressWrite({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toEqual({});
    expect(r.impliesZipWrite).toBe(false);
  });

  it("住所と郵便番号を一緒に送ればそのまま通る", () => {
    const r = resolveCurrentAddressWrite({
      currentAddress: "渋谷区神宮前1-1-1",
      currentZip: "150-0001",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toEqual({
      currentAddress: "渋谷区神宮前1-1-1",
      currentZip: "150-0001",
    });
    expect(r.impliesZipWrite).toBe(true);
  });

  it("⚠住所だけ送られたら、郵便番号を空にする（古い番号を残さない）", () => {
    const r = resolveCurrentAddressWrite({ currentAddress: "渋谷区神宮前1-1-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toEqual({
      currentAddress: "渋谷区神宮前1-1-1",
      currentZip: null,
    });
    // ⚠これは「郵便番号への書き込み」なので、呼び出し側は owner_zip の権限を見る
    expect(r.impliesZipWrite).toBe(true);
  });

  it("⚠郵便番号だけの更新は拒否する（対になる住所が無い）", () => {
    const r = resolveCurrentAddressWrite({ currentZip: "150-0001" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("zip_only");
  });

  it("⚠郵便番号だけを null で送るのも拒否する（片側だけの操作は許さない）", () => {
    const r = resolveCurrentAddressWrite({ currentZip: null });
    expect(r.ok).toBe(false);
  });

  it("現住所を空にする（未設定へ戻す）ときも、郵便番号を一緒に空にする", () => {
    const r = resolveCurrentAddressWrite({ currentAddress: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toEqual({ currentAddress: null, currentZip: null });
    expect(r.impliesZipWrite).toBe(true);
  });

  it("⚠形式を理由に郵便番号を捨てない（海外の番号が消えない）", () => {
    for (const z of ["10001", "SW1A 1AA", "100000"]) {
      const r = resolveCurrentAddressWrite({
        currentAddress: "海外の住所",
        currentZip: z,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.fields.currentZip, `${z} が消えている`).toBe(z);
    }
  });
});

/**
 * useAddressLookup の配線を source assertion で固定する（node 環境のため描画テスト不可）。
 * 振る舞いの核（reducer / isLatestRequest / 分類）は address-lookup-ui-utils.test.ts で実検証する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(process.cwd(), "src/hooks/use-address-lookup.ts"),
  "utf8",
);

describe("useAddressLookup の配線", () => {
  it("client component 宣言がある", () => {
    expect(src).toMatch(/^["']use client["'];/m);
  });

  it("api-client の wrapper を呼ぶ（route 経由＝APIキー非露出）", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/api-client["']/);
    expect(src).toContain("fetchAddressByPostalCode");
    expect(src).toContain("fetchAddressCandidates");
  });

  it("住所検索は debounce 300ms（#5）", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/debounce["']/);
    expect(src).toContain("debounce(");
    expect(src).toContain("300");
  });

  it("reducer / 初期状態 を utils から使う", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/address-lookup-ui-utils["']/);
    expect(src).toContain("addressLookupReducer");
    expect(src).toContain("initialLookupState");
  });

  it("stale response 対策に seq ref + isLatestRequest を使う（#6）", () => {
    expect(src).toContain("useRef");
    expect(src).toContain("isLatestRequest");
  });

  it("郵便番号→住所は明示（debounce なし）の lookupByPostalCode を公開", () => {
    expect(src).toContain("lookupByPostalCode");
  });

  it("loading / error / candidates / reset / searchByAddress を公開", () => {
    for (const k of [
      "loading",
      "error",
      "candidates",
      "reset",
      "searchByAddress",
    ]) {
      expect(src).toContain(k);
    }
  });

  it("debounce は cleanup で cancel する", () => {
    expect(src).toContain("cancel");
  });

  it("APIキー/サーバ provider/orchestrator を露出しない（#8）", () => {
    expect(src).not.toContain("ADDRESS_LOOKUP_API_KEY");
    expect(src).not.toContain("process.env.ADDRESS_LOOKUP");
    expect(src).not.toContain("japanpost-provider");
    expect(src).not.toMatch(/from\s+["']@\/lib\/address-lookup["']/);
  });
});

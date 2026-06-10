/**
 * useAddressLookup の配線を source assertion で固定する（node 環境のため描画テスト不可）。
 * 振る舞いの核（reducer / controller の seq stale ガード / debounce / cancel / 分類）は
 * address-lookup-ui-utils.test.ts で実検証する。
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

  it("検索実行（seq stale ガード/debounce/cancel）は createAddressLookupController に集約（#6・Codex P2-1/P2-B）", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/address-lookup-ui-utils["']/);
    expect(src).toContain("createAddressLookupController");
    expect(src).toContain("controllerRef");
    expect(src).toContain("useRef");
  });

  it("住所検索は debounce 300ms を controller へ渡す（#5）", () => {
    expect(src).toContain("SEARCH_DEBOUNCE_MS = 300");
    expect(src).toMatch(/createAddressLookupController\(/);
  });

  it("reducer / 初期状態 を utils から使う", () => {
    expect(src).toContain("addressLookupReducer");
    expect(src).toContain("initialLookupState");
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

  it("unmount cleanup で dispose（保留 debounce cancel＋遅延応答破棄）する", () => {
    expect(src).toContain("dispose");
  });

  it("APIキー/サーバ provider/orchestrator を露出しない（#8）", () => {
    expect(src).not.toContain("ADDRESS_LOOKUP_API_KEY");
    expect(src).not.toContain("process.env.ADDRESS_LOOKUP");
    expect(src).not.toContain("japanpost-provider");
    expect(src).not.toMatch(/from\s+["']@\/lib\/address-lookup["']/);
  });
});

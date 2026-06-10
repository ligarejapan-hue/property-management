/**
 * AddressLookupControls の配線を source assertion で固定する（node 環境＝描画テスト不可）。
 * まだどのフォームにも組み込まないため、本 PR ではこの存在＋配線のみを検証する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(process.cwd(), "src/components/address/address-lookup-controls.tsx"),
  "utf8",
);

describe("AddressLookupControls の配線", () => {
  it("client component で export されている", () => {
    expect(src).toMatch(/^["']use client["'];/m);
    expect(src).toMatch(/export function AddressLookupControls/);
  });

  it("仕様どおりの props を受け取る", () => {
    for (const prop of [
      "zip",
      "address",
      "onZipChange",
      "onAddressChange",
      "disabled",
      "mode",
    ]) {
      expect(src).toContain(prop);
    }
  });

  it("useAddressLookup hook を使う", () => {
    expect(src).toMatch(/from\s+["']@\/hooks\/use-address-lookup["']/);
    expect(src).toContain("useAddressLookup");
    expect(src).toContain("lookupByPostalCode");
    expect(src).toContain("searchByAddress");
  });

  it("郵便番号→住所は明示ボタン「住所を自動入力」", () => {
    expect(src).toContain("住所を自動入力");
  });

  it("候補は formatCandidateLabel で表示し、複数なら選択 UI", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/address-lookup-ui-utils["']/);
    expect(src).toContain("formatCandidateLabel");
    expect(src).toContain("requiresCandidateSelection");
  });

  it("silent overwrite を禁止＝既存住所は上書き確認する", () => {
    expect(src).toContain("needsOverwriteConfirm");
    expect(src).toContain("shouldAutofillAddress");
    expect(src).toContain("上書き");
  });

  it("loading / error を扱う（spinner と分類済みエラー文言）", () => {
    expect(src).toMatch(/Loader2|検索中/);
    expect(src).toContain("ERROR_MESSAGES");
    expect(src).toContain("not_configured");
  });

  it("disabled 中は住所検索 effect を走らせない（Codex P2-A）＝decide で分岐し deps に disabled を含む", () => {
    expect(src).toContain("decideAddressSearchEffect");
    expect(src).toMatch(
      /decideAddressSearchEffect\(showSearch,\s*disabled,\s*address\)/,
    );
    expect(src).toMatch(
      /\[address,\s*showSearch,\s*disabled,\s*searchByAddress,\s*reset\]/,
    );
  });

  it("APIキー/サーバ provider/orchestrator を露出しない（#8）", () => {
    expect(src).not.toContain("ADDRESS_LOOKUP_API_KEY");
    expect(src).not.toContain("process.env.ADDRESS_LOOKUP");
    expect(src).not.toContain("japanpost-provider");
    expect(src).not.toMatch(/from\s+["']@\/lib\/address-lookup["']/);
  });
});

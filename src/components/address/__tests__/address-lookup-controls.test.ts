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

  it("仕様どおりの props を受け取る（addressEdited=user-edit signal 含む）", () => {
    for (const prop of [
      "zip",
      "address",
      "onZipChange",
      "onAddressChange",
      "disabled",
      "mode",
      "addressEdited",
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

  it("silent overwrite を禁止＝既存住所は確認まで zip も住所も反映しない（Codex P2-C）", () => {
    expect(src).toContain("needsOverwriteConfirm");
    expect(src).toContain("planCandidateApplication");
    expect(src).toContain("pendingCandidate");
    expect(src).toContain("上書き");
    // 確認確定時に zip と住所を同時反映する helper（plan 経由）
    expect(src).toMatch(
      /const applyPlanNow[\s\S]*?onZipChange[\s\S]*?onAddressChange[\s\S]*?reset\(\)/,
    );
    // キャンセルは pending（候補＋コンテキスト）を捨てるだけ＝親フォームを一切更新しない (#2)
    expect(src).toContain("clearPending");
    expect(src).toMatch(/onClick=\{clearPending\}/);
  });

  it("郵便番号lookupの単一候補は onSuccess で自動反映（空住所）/上書き確認（既存住所）（Codex P2-D）", () => {
    expect(src).toContain("isSingleCandidate");
    // lookup 開始時に zip を requestedZip として捕捉して渡す（P2-I）。
    expect(src).toMatch(/lookupByPostalCode\(requestedZip,/);
  });

  it("loading / error を扱う（spinner と分類済みエラー文言）", () => {
    expect(src).toMatch(/Loader2|検索中/);
    expect(src).toContain("ERROR_MESSAGES");
    expect(src).toContain("not_configured");
  });

  it("住所検索 effect は evaluateAddressSearchEffect で判定（P2-A disabled / P2-E mount・編集ガード）", () => {
    expect(src).toContain("evaluateAddressSearchEffect");
    expect(src).toContain("searchGuardRef");
    expect(src).toMatch(
      /\[address,\s*addressEdited,\s*showSearch,\s*disabled,\s*searchByAddress,\s*reset\]/,
    );
  });

  it("user-edit signal: addressEdited を effect 判定へ渡し、default false＝fail-closed（P2-G）", () => {
    // 親フォームの非同期ロードで address prop が「空→保存済み住所」と変化しても、
    // UI 入力イベント由来の addressEdited が立っていない限り検索しない。
    expect(src).toMatch(/addressEdited\s*=\s*false/);
    expect(src).toMatch(
      /evaluateAddressSearchEffect\(\s*showSearch,\s*disabled,\s*addressEdited,\s*address,/,
    );
    // component 自身は touched を立てない（input を所有しない＝親が UI 入力
    // イベントでのみ立てる契約）。candidate 適用でも立てない。
    expect(src).not.toMatch(/setAddressEdited|addressEdited\s*=\s*true/);
  });

  it("postal 結果は生成元 zip に紐付け、zip 変更で stale 化する（P2-H）", () => {
    // hook state の attemptedZip を読み、isPostalResultForZip で現在 zip と照合。
    expect(src).toContain("attemptedZip");
    expect(src).toContain("isPostalResultForZip");
    // 「該当なし」表示は現在 zip に対応する postal 結果のときだけ。
    expect(src).toMatch(/showNoResult[\s\S]*?isPostalResultForZip\(zip,\s*attemptedZip\)/);
    // stale 判定（zip 変更後の旧 postal 結果）を一箇所に持つ。
    expect(src).toContain("postalResultStale");
  });

  it("stale な postal 候補は applyCandidate で適用拒否する（P2-H・defense-in-depth）", () => {
    // applyCandidate 冒頭で stale postal を弾く＝古い候補をクリックしても親へ反映しない。
    expect(src).toMatch(/const applyCandidate = \([\s\S]*?postalResultStale[\s\S]*?return/);
  });

  it("postalAttempted の boolean フラグには依存しない＝生成元 zip を見る（P2-H）", () => {
    // 「検索したか」ではなく「現在 zip に対応する結果か」で表示制御する。
    expect(src).not.toContain("postalAttempted");
  });

  it("postal autofill は非同期 onSuccess で stale ZIP を弾く（P2-I・副作用 guard）", () => {
    // lookup 開始時の zip を requestedZip として捕捉し、応答到着時の現在 zip(zipRef) と
    // 照合してから auto-apply する＝render-time guard では守れない非同期経路を守る。
    expect(src).toContain("requestedZip");
    expect(src).toContain("zipRef");
    expect(src).toContain("shouldApplyPostalAutofill");
    // onSuccess 継続内（applyPlanNow より前）で stale なら early return する。
    expect(src).toMatch(
      /shouldApplyPostalAutofill\(zipRef\.current,\s*requestedZip\)[\s\S]*?return/,
    );
  });

  it("pendingCandidate は設定時コンテキストを持ち、zip/住所変化で stale 化する（A 横断）", () => {
    // 確認 UI 表示中に zip/住所が変わったら古い候補を表示・confirm させない。
    expect(src).toContain("pendingContext");
    expect(src).toContain("isPendingCandidateStale");
    expect(src).toContain("pendingStale");
    // confirmOverwrite は stale なら反映しない（副作用 guard）。
    expect(src).toMatch(
      /const confirmOverwrite = \(\) => \{[\s\S]*?(pendingStale|isPendingCandidateStale)[\s\S]*?return/,
    );
  });

  it("APIキー/サーバ provider/orchestrator を露出しない（#8）", () => {
    expect(src).not.toContain("ADDRESS_LOOKUP_API_KEY");
    expect(src).not.toContain("process.env.ADDRESS_LOOKUP");
    expect(src).not.toContain("japanpost-provider");
    expect(src).not.toMatch(/from\s+["']@\/lib\/address-lookup["']/);
  });
});

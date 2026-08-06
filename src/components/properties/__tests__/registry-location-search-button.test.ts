import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// このコンポーネントは render 基盤（jsdom/RTL）未導入のため source-assertion で
// 配色（dark 可読化）・配線（cond①①③ / 権限ゲート / PII 非ログ）を固定する。
const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "registry-location-search-button.tsx"), "utf8");

describe("registry-location-search-button.tsx: 配線（所在検索→候補→取得）", () => {
  it("非 admin（canAutoFetch=false）には何も描画しない", () => {
    expect(src).toContain("if (!canAutoFetch) return null");
  });
  it("provider 未設定は disabled + 理由文（本番 501 fail-closed の UI 版）", () => {
    expect(src).toContain("providerDisabled");
    expect(src).toContain("未設定のため現在利用できません");
  });
  it("検索は api-client searchRegistryCandidates を使う (実況パネル用 liveRef 同封)", () => {
    expect(src).toContain("searchRegistryCandidates(propertyId, ref)");
  });
  it("取得は candidateRef と種別を渡して obtainRegistryByCandidate を使う（cond③ server 再解決）", () => {
    expect(src).toContain("obtainRegistryByCandidate(");
    expect(src).toContain("selected.candidateRef");
    // 請求種別(所有者事項/全部事項)を選んで渡す。
    expect(src).toContain("certificateType");
  });
  it("取得の確認で種別(所有者事項=既定/全部事項)を選べる", () => {
    expect(src).toContain("全部事項");
    expect(src).toContain('setCertificateType("all")');
    expect(src).toContain('setCertificateType("owner")');
  });
  it("cond①: 検索・取得の前に明示確認（confirm）を挟む", () => {
    expect(src).toContain('"confirmSearch"');
    expect(src).toContain('"confirmObtain"');
    expect(src).toContain("有料処理になり得ます");
  });
  it("searchable:false の reason（has_real_estate_number / insufficient_location）を扱う", () => {
    expect(src).toContain("has_real_estate_number");
    expect(src).toContain("insufficient_location");
  });
  it("成功レスポンス本文を UI に持ち込まず onComplete で親再取得に委ねる", () => {
    expect(src).toContain("onComplete()");
  });
  it("cond②: 候補（所在等）を console/log に出さない", () => {
    expect(src).not.toContain("console.");
  });
  it("段階②(2026-08-01): 取得は purchaseEnabled(専用オプトイン)のときだけ有効・確認画面を経由する", () => {
    // @codex #345 P1: 無料検索の校正フラグだけで課金操作を露出させない。
    // capabilities.registryPurchase(=REGISTRY_FETCH_PURCHASE_ENABLED)が false のとき
    // 取得ボタンは disabled + 準備中表示(server 側も 501 で enforce)。
    expect(src).toContain("purchaseEnabled: boolean");
    expect(src).toContain("disabled={!purchaseEnabled}");
    expect(src).toContain("有料取得は準備中です");
    // 有効時も**ワンクリック課金にはしない**: 「取得」→確認画面→「取得する」の2段。
    expect(src).toContain('setState("confirmObtain")');
    expect(src).toContain("利用料が発生します");
    expect(src).toContain("この候補で謄本を取得しますか？");
    // 押下ハンドラも purchaseEnabled を再確認する(disabled 迂回への二重防御)。
    expect(src).toContain("if (!purchaseEnabled) return;");
  });
});

describe("registry-location-search-button.tsx: dark 配色（暗面可読化）", () => {
  const darkClasses = [
    "dark:text-amber-400",
    "dark:text-green-400",
    "dark:text-red-400",
    "dark:text-gray-400",
    "dark:text-gray-300",
    "dark:text-gray-200",
    "dark:text-indigo-300",
    "dark:text-indigo-400",
    "dark:bg-indigo-500/15",
    "dark:border-indigo-500/30",
    "dark:bg-gray-900",
    "dark:bg-gray-800/60",
    "dark:border-gray-700",
    "dark:hover:bg-gray-800",
  ];
  for (const cls of darkClasses) {
    it(`${cls} がある`, () => {
      expect(src).toContain(cls);
    });
  }

  // ライト不変担保（solid ボタン + accent 地/文字）。
  const lightClasses = [
    "bg-indigo-600",
    "text-white",
    "hover:bg-indigo-700",
    "border-indigo-200",
    "bg-indigo-50",
    "text-indigo-800",
    "text-indigo-700",
    "text-amber-700",
    "text-green-600",
    "text-red-600",
    "bg-white",
    "border-gray-300",
    "hover:bg-gray-50",
  ];
  for (const cls of lightClasses) {
    it(`ライト ${cls} が残っている`, () => {
      expect(src).toContain(cls);
    });
  }
});

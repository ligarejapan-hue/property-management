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
    // ⚠候補は**引数で**受け取る(候補1件の自動進行では state の反映を待てないため)。
    expect(src).toContain("const runObtain = async (");
    expect(src).toContain("target.candidateRef");
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
  it("取得成功で**その場では**親を再取得しない(@codex #380 R3 P2)", () => {
    // その場で再取得すると詳細ページが読み込み中の画面に差し替わり、このボタンごと
    // 作り直される=実況の見返し(最後のスクショ・3分)が即座に消える。
    // 地番保存(#373 R10 P2)と同じく、閉じるとき(reset)にまとめて流す。
    expect(src).toContain("propertyRefreshPendingRef.current = true;");
    expect(src).not.toContain("onComplete");
    expect(src).toContain("閉じる（物件情報を更新）");
  });
  it("cond②: 候補（所在等）を console/log に出さない", () => {
    expect(src).not.toContain("console.");
  });
  it("段階②(2026-08-01): 取得は purchaseEnabled(専用オプトイン)のときだけ有効・確認画面を経由する", () => {
    // @codex #345 P1: 無料検索の校正フラグだけで課金操作を露出させない。
    // capabilities.registryPurchase(=REGISTRY_FETCH_PURCHASE_ENABLED)が false のとき
    // 取得ボタンは disabled + 準備中表示(server 側も 501 で enforce)。
    expect(src).toContain("purchaseEnabled: boolean");
    // 2026-08-19: ゲートは**候補一覧の行**から**確認画面の「取得する（有料）」**へ移した
    //   (同じ画面に課金しない「取り込む」を並べるため)。塞ぐ強さは変えない。
    expect(src).toContain("取得する（有料）");
    expect(src).toMatch(
      /onClick=\{\(\) => runObtain\([\s\S]{0,80}?\)\}[\s\S]{0,200}?disabled=\{[\s\S]{0,80}?!purchaseEnabled/,
    );
    expect(src).toContain("有料取得は準備中です");
    // ⚠**2026-08-21 発注者指示で運用が変わった**: 候補が**1件**のときは「選ぶ」も確認画面も
    //   挟まず、そのまま取得(課金)まで進む。手動の2段(選ぶ→確認→取得)は
    //   **有料スイッチが切れている環境**と**回収**で今も使うため残る(下の pin はその経路)。
    //   ⚠代わりの砦=**検索中の「中止」**。押して受け付けられたら取得へ進まない
    //   (純関数 decideAfterSearch で全条件を実測)。課金の後は取り消せない。
    expect(src).toContain('setState("confirmObtain")');
    expect(src).toContain("利用料が発生します");
    expect(src).toContain("この候補で何をしますか？");
    // 押下ハンドラも purchaseEnabled を再確認する(disabled 迂回への二重防御)。
    expect(src).toContain("if (!purchaseEnabled) return;");
  });
});

describe("registry-location-search-button.tsx: dark 配色（暗面可読化）", () => {
  const darkClasses = [
    "dark:text-amber-400",
    "dark:text-green-400",
    // 2026-08-20: 失敗の表示を**帯**にした（見落とし防止）。赤の対は
    //   text-red-700 ↔ dark:text-red-300 + 地と枠。他画面の警告帯と同じ流儀。
    "dark:text-red-300",
    "dark:border-red-800",
    "dark:bg-red-950/40",
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
    "text-red-700",
    "border-red-300",
    "bg-red-50",
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

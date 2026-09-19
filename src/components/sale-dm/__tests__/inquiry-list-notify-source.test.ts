import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const root = process.cwd();
const list = readFileSync(path.join(root, "src/components/sale-dm/inquiry-list.tsx"), "utf8");
const page = readFileSync(path.join(root, "src/app/(dashboard)/properties/sale-dm/inquiries/page.tsx"), "utf8");
const sidebar = readFileSync(path.join(root, "src/components/layout/sidebar-model.tsx"), "utf8");

describe("査定の申込 画面", () => {
  it("通知の失敗と再送・通知先未設定の案内", () => {
    expect(list).toContain("通知できていません");
    expect(list).toContain("再送");
    expect(list).toContain("resendSaleDmInquiryNotify");
    expect(list).toContain("通知先が未設定です");
  });
  it("横断モードとリンクの focus", () => {
    expect(page).toContain('mode="all"');
    expect(page).toMatch(/searchParams|useSearchParams/);
    expect(page).toContain("focus");
  });
  it("画面保護の印を保つ", () => {
    expect(list).toContain('data-pii-protected');
  });
  it("サイドバー: DM グループに office_staff で「査定の申込」", () => {
    expect(sidebar).toMatch(/label:\s*"査定の申込",\s*href:\s*"\/properties\/sale-dm\/inquiries"[^}]*minRole:\s*"office_staff"/);
  });
});

// fix round 1(コントローラーレビュー)Important #1: 「通知先が未設定です」は横断モード専用の
// 項目(campaign モードの応答には notifyRecipientCount が無い)。走査テストが文字列の存在
// だけを見ていると、ゲートを外して常時表示にしても・反転させても緑のまま通ってしまう
// (=「campaign パネルは変えない」という要件を守れない)。ここではゲートの条件式そのものと、
// campaign 分岐の読み込みコードを直接検証する。
describe("通知先0人の案内は横断モード専用(ゲートそのものを検証)", () => {
  it("mode===\"all\" && notifyRecipientCount===0 という条件でだけ表示される", () => {
    const guard = list.match(/\{mode\s*===\s*"all"\s*&&\s*notifyRecipientCount\s*===\s*0\s*&&\s*\(/);
    expect(guard, "ゲート条件(mode===\"all\" && notifyRecipientCount===0)が見つかりません").not.toBeNull();
    // ゲートの直後の JSX が実際にこの案内文言であること(無関係な条件式に紛れていない)。
    const afterGuard = list.slice(guard!.index!, guard!.index! + 400);
    expect(afterGuard).toContain("通知先が未設定です");
  });

  it("ゲートが反転していない(mode!==や notifyRecipientCount!==0 で出す変更を検出する)", () => {
    expect(list).not.toMatch(/mode\s*!==\s*"all"[\s\S]{0,150}通知先が未設定です/);
    expect(list).not.toMatch(/notifyRecipientCount\s*!==\s*0[\s\S]{0,150}通知先が未設定です/);
    expect(list).not.toMatch(/mode\s*===\s*"campaign"[\s\S]{0,150}通知先が未設定です/);
  });

  it("campaign モードの読み込み(load/loadMore の campaign 分岐)は notifyRecipientCount を読まない", () => {
    const loadSrc = list.slice(
      list.indexOf("const load = useCallback"),
      list.indexOf("useEffect(() => {\n    void load();"),
    );
    const loadCampaignBranch = loadSrc.match(/\} else if \(campaign\) \{[\s\S]*?\n      \}/);
    expect(loadCampaignBranch, "load() の campaign 分岐が見つかりません").not.toBeNull();
    expect(loadCampaignBranch![0]).not.toMatch(/notifyRecipientCount/);

    const loadMoreSrc = list.slice(
      list.indexOf("const loadMore = async"),
      list.indexOf("const recipientName ="),
    );
    const loadMoreCampaignBranch = loadMoreSrc.match(/\} else if \(campaign\) \{[\s\S]*?\n      \}/);
    expect(loadMoreCampaignBranch, "loadMore() の campaign 分岐が見つかりません").not.toBeNull();
    expect(loadMoreCampaignBranch![0]).not.toMatch(/notifyRecipientCount/);
  });
});

// fix round 1 Minor #2/#3: 再送ボタンは送信中も DOM に残す(disabled で切り替える)。
// 失敗はパネル全体のエラー帯ではなく行ごとの状態(resendErrors)に出す。
describe("再送ボタンと再送エラーの表示(fix round 1)", () => {
  it("再送ボタンは disabled で切り替える(送信中も消さない)", () => {
    expect(list).toMatch(/disabled=\{resendingIds\.has\(i\.id\)\}/);
    // 従来の「送信中はボタンごと非表示にする」書き方(!resendingIds.has(i.id) && <button)が
    // 残っていないこと。
    expect(list).not.toMatch(/\{!resendingIds\.has\(i\.id\)\s*&&\s*\(\s*<button/);
  });

  it("再送の失敗は行ごとの resendErrors で表示し、パネル全体の setError は使わない", () => {
    expect(list).toContain("resendErrors");
    // resendNotify 関数の本体だけを切り出し、setResendErrors を呼び setError を呼んでいないことを確認する。
    const start = list.indexOf("const resendNotify =");
    const bodyEnd = list.indexOf("\n  };", start);
    expect(start).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(start);
    const resendNotifyFn = list.slice(start, bodyEnd);
    expect(resendNotifyFn).toContain("setResendErrors");
    expect(resendNotifyFn).not.toMatch(/setError\(/);
  });
});

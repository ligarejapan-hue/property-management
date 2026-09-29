import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/(desk)/inquiry-desk/page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("受付の窓の画面", () => {
  it("上から 今日明日の内見 → 登録フォーム → 一覧 の順に並べる(設計 §2.1)", () => {
    const a = src.indexOf("<UpcomingViewingsView");
    const b = src.indexOf("<InquiryForm");
    const c = src.indexOf("<InquiryListView");
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
  it("権限が無いときは1つの文言(反響の受付の権限がありません)", () => {
    expect(src).toContain("反響の受付の権限がありません");
    expect(src).toMatch(/FORBIDDEN/);
  });
  it("保存したら 一覧・今日明日・件数 を読み直す", () => {
    expect(src).toMatch(/onSaved=\{reloadAll\}/);
  });
  it("未対応件数を枠へ渡す", () => {
    expect(src).toContain("DESK_OPEN_COUNT_EVENT");
  });
});

describe("読み込みの失敗を「ありません」に見せない(@codex #459 R1)", () => {
  it("403 以外の失敗は知らせて、もう一度読める", () => {
    expect(src).toContain("読み込めませんでした");
    expect(src).toMatch(/setLoadError\(/);
    expect(src).toContain("もう一度読む");
  });
});

describe("候補は今の検索語のものだけ(@codex #459 R1)", () => {
  it("業者・物件の候補欄は hitsForQuery で今の検索語の結果だけ出し、失敗を別に知らせる", () => {
    for (const f of ["agent-picker.tsx", "property-picker.tsx"]) {
      const s = readFileSync(join(process.cwd(), "src/components/agent-inquiry", f), "utf8");
      expect(s, f).toContain("hitsForQuery(");
      expect(s, f).toContain("検索できませんでした");
    }
  });
});

describe("画面保護(設計 §4)と もっと見る(@codex #459 R2)", () => {
  it("受付の窓も画面保護(透かし・コピー/印刷の抑止と記録)の対象", () => {
    const layout = readFileSync(join(process.cwd(), "src/app/(desk)/layout.tsx"), "utf8");
    expect(layout).toContain("<ScreenProtectionProvider>");
    expect(src).toMatch(/data-pii-protected/);
    expect(src).toMatch(/data-pii-surface="dashboard"/);
  });
  it("もっと見るは絞り込みを替えた後の古い応答を捨て、連打しない", () => {
    expect(src).toMatch(/listGenRef\.current !== gen/);
    expect(src).toMatch(/loadingMoreRef\.current/);
  });
});

describe("担当者の一覧の読み込み失敗も知らせる(@codex #459 R3)", () => {
  it("fetchUsers も同じ読み込み(失敗なら知らせる・もう一度読むで読み直す)に入れる", () => {
    expect(src).not.toMatch(/fetchUsers\(\)[\s\S]{0,200}\.catch\(\(\) => \{\}\)/);
    expect(src).toMatch(/Promise\.all\(\[[\s\S]*fetchUsers\(\)/);
  });
});

describe("タブを替えたら前のタブの行を出さない(@codex #459 R4)", () => {
  it("一覧は今の絞り込みで読んだ行だけ出す", () => {
    expect(src).toMatch(/listKey === filterKey/);
  });
});

describe("もっと見るの古い失敗で今の一覧を「読み込めませんでした」にしない(@codex #459 R5)", () => {
  it("失敗の知らせも世代を確かめてから", () => {
    expect(src).toMatch(/catch \(e\) \{\s*if \(listGenRef\.current === gen\) onError\(e\);/);
  });
});

describe("開いたままの窓で権限を外されたら表示を消す・もっと見るの鍵は世代ごと(@codex #459 R10)", () => {
  it("画面保護が読み直す権限を見て、閲覧権限が無ければ中身を出さない", () => {
    expect(src).toContain("useScreenProtection()");
    expect(src).toMatch(/hasPermission\(permissions, "agent_inquiry", "read"\)/);
    expect(src).toMatch(/if \(forbidden \|\| revoked\)/);
  });
  it("もっと見るの鍵はその時の一覧の世代だけに効く", () => {
    expect(src).toMatch(/loadingMoreRef\.current === listGenRef\.current/);
  });
});

describe("権限が分からない間は中身を出さない・詳細は反響ごとに作り直す(@codex #459 R11)", () => {
  it("権限が読めていない(null)なら出さない。読み込み中の表示と、失敗なら読み直すボタン", () => {
    expect(src).toMatch(/if \(permissions == null \|\| !permissionsSettled\)/);
    expect(src).toContain("権限を確かめています");
    expect(src).toMatch(/refetchPermissions\(\)/);
  });
  it("詳細は開いた反響の id で作り直す(前の反響の遅い応答で別の反響を開かない)", () => {
    expect(src).toMatch(/<InquiryDetail\s+key=\{openId\}/);
  });
});

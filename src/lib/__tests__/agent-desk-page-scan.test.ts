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

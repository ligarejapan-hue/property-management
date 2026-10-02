import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
import { AgentDirectoryRows, AgentSearchHits } from "../agent-directory";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("業者の名簿の一覧(設計 §2.3)", () => {
  const rows = [
    { id: "a1", companyName: "○○不動産", branchName: "新宿支店", phone: "03-1234-5678", isArchived: false, inquiryCount: 7, lastReceivedAt: "2026-09-29T01:00:00.000Z" },
    { id: "a2", companyName: "△△住宅", branchName: null, phone: "03-9876-5432", isArchived: false, inquiryCount: 0, lastReceivedAt: null },
  ];
  it("支店名まで・代表電話・反響件数・最終日を出し、詳細へ行ける", () => {
    const out = renderToStaticMarkup(<AgentDirectoryRows rows={rows} />);
    expect(out).toContain("○○不動産 新宿支店");
    expect(out).toContain("03-1234-5678");
    expect(out).toContain("反響 7件");
    expect(out).toContain("最終 2026/9/29");
    expect(out).toContain('href="/agents/a1"');
  });
  it("反響がまだ無い業者は「反響なし」", () => {
    expect(renderToStaticMarkup(<AgentDirectoryRows rows={rows} />)).toContain("反響なし");
  });
  it("0件のとき", () => {
    expect(renderToStaticMarkup(<AgentDirectoryRows rows={[]} />)).toContain("業者がありません");
  });
  it("検索の結果=携帯で当たったら前回の問い合わせ者の名前に保護の印を付ける", () => {
    const out = renderToStaticMarkup(
      <AgentSearchHits hits={[{ id: "a1", companyName: "○○不動産", branchName: null, phone: "03-1234-5678", matchedBy: "mobile", lastContact: { name: "田中", mobile: "090-1111-2222", email: null } }]} />,
    );
    expect(out).toContain('href="/agents/a1"');
    expect(out).toMatch(/data-pii-protected="true" data-pii-surface="dashboard"[^>]*>[^<]*田中様/);
  });
});

describe("名簿の画面", () => {
  const page = () => read("src/app/(dashboard)/agents/page.tsx");
  it("題名はメニューの名前と同じ(素の文字列)", () => {
    expect(page()).toContain('<PageHeader title="業者の名簿"');
  });
  it("★権限が無いときは1つの文言", () => {
    expect(page()).toContain("反響の受付の権限がありません");
    expect(page()).toMatch(/FORBIDDEN/);
  });
  it("読み込みの失敗を「業者がありません」に見せない", () => {
    expect(page()).toContain("読み込めませんでした");
    expect(page()).toContain("もう一度読む");
  });
  it("新しく登録は、探し終えてから・書ける人にだけ出す(二重登録を防ぐ)", () => {
    expect(page()).toContain("newAgentAction(");
    expect(page()).toMatch(/canWrite && createAction !== "none"/);
  });
  it("通信の失敗では書けるかどうかを変えない。権限なしのときだけ落とす", () => {
    expect(page().match(/setCanWrite\(false\)/g)).toHaveLength(1);
    expect(page()).toMatch(/if \(forbidden\) setCanWrite\(false\)/);
  });
  it("候補は今の検索語のものだけ", () => {
    expect(page()).toContain("hitsForQuery(");
  });
  it("権限表を自分で読まない(書けるかはサーバーの canWrite)", () => {
    expect(page()).not.toContain("useScreenProtection");
  });
  it("個人情報の保護の対象にする", () => {
    expect(page()).toMatch(/data-pii-protected data-pii-surface="dashboard"/);
  });
});

describe("もっと見るの読み込み中", () => {
  it("もっと見るは読み込み中に押せず「読み込み中…」(名簿の一覧・詳細)", () => {
    for (const f of ["src/app/(dashboard)/agents/page.tsx", "src/app/(dashboard)/agents/[id]/page.tsx"]) {
      const s = read(f);
      expect(s, f).toMatch(/disabled=\{loadingMore\}/);
      expect(s, f).toContain('{loadingMore ? "読み込み中…" : "もっと見る"}');
      expect(s, f).toMatch(/finally \{[\s\S]{0,120}setLoadingMore\(false\)/);
    }
  });
});

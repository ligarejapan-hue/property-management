/**
 * ページ見出し (UI一貫性 第2弾 ⑧) と 戻る導線 (⑩) のSSRテスト。
 *
 * 背景: h1 の書式が10種類(実測)・「戻る」の文言が3種類に揺れていた。
 * 見出しは「題名+説明+右端の操作」を1部品に、戻るは「← ◯◯へ戻る」
 * (行き先を明記)に統一する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "../page-header";
import { BackLink } from "../back-link";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("PageHeader", () => {
  it("h1 は統一書式(text-2xl font-bold + dark対応)", () => {
    const html = render(<PageHeader title="物件一覧" />);
    expect(html).toMatch(/<h1[^>]*class="[^"]*text-2xl[^"]*"/);
    expect(html).toMatch(/<h1[^>]*class="[^"]*font-bold[^"]*"/);
    expect(html).toMatch(/<h1[^>]*class="[^"]*dark:text-gray-100[^"]*"/);
    expect(html).toContain("物件一覧");
  });

  it("説明文は title の下に小さく(muted)出る", () => {
    const html = render(
      <PageHeader title="添付横断検索" description="メタデータのみを横断検索します" />,
    );
    expect(html).toContain("メタデータのみを横断検索します");
    expect(html).toMatch(/text-sm[^"]*text-gray-500|text-gray-500[^"]*text-sm/);
  });

  it("actions は右端に出る(flex justify-between)", () => {
    const html = render(
      <PageHeader title="利用者管理" actions={<button type="button">新規</button>} />,
    );
    expect(html).toContain("justify-between");
    expect(html).toContain("新規");
  });

  it("back を渡すと見出しの上に戻る導線が出る", () => {
    const html = render(
      <PageHeader title="棟詳細" back={{ href: "/buildings", to: "棟一覧" }} />,
    );
    expect(html).toContain('href="/buildings"');
    expect(html).toContain("棟一覧へ戻る");
  });
});

describe("BackLink", () => {
  it("文言は「◯◯へ戻る」+左向き矢印に固定(行き先を必ず明記)", () => {
    const html = render(<BackLink href="/properties" to="物件一覧" />);
    expect(html).toContain('href="/properties"');
    expect(html).toContain("物件一覧へ戻る");
    // lucide の ArrowLeft(svg)を含む
    expect(html).toContain("<svg");
  });

  it("リンクの見た目は muted(押し間違いを誘わない控えめな導線)", () => {
    const html = render(<BackLink href="/x" to="一覧" />);
    expect(html).toMatch(/text-gray-500|text-gray-400/);
  });
});

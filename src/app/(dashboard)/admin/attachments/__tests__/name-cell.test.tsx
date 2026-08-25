/**
 * 添付ファイル検索の「ファイル名」セル。
 * jsdom を使わない方針のため、SSR した文字列で見た目と行き先を固定する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentNameCell } from "../page";

const UUID = "11111111-2222-4333-8444-555555555555";
const CREATED = "2026-08-25T03:00:00.000Z"; // JST 2026-08-25 12:00

const hit = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  fileName: "registry-auto-2024121100710215.pdf",
  type: "registry",
  registryCertificateType: "owner" as string | null,
  createdAt: CREATED,
  targetType: "property",
  targetId: UUID,
  ...over,
});

describe("添付ファイル検索のファイル名セル", () => {
  it("自動取得の謄本は、機械の名前ではなく揃えた名前で出す", () => {
    const html = renderToStaticMarkup(<AttachmentNameCell hit={hit()} />);
    expect(html).toContain("謄本(所有者事項)_2026-08-25.pdf");
    expect(html).not.toContain("registry-auto-");
  });

  it("手作業で取り込んだ謄本は元のファイル名のまま（発注者決定）", () => {
    const html = renderToStaticMarkup(
      <AttachmentNameCell
        hit={hit({
          registryCertificateType: null,
          fileName: "世田谷区弦巻１丁目３２－３１不動産登記.pdf",
        })}
      />,
    );
    expect(html).toContain("世田谷区弦巻");
    expect(html).not.toContain("謄本(");
  });

  it("一般の添付も元のファイル名のまま", () => {
    const html = renderToStaticMarkup(
      <AttachmentNameCell
        hit={hit({ type: "general", registryCertificateType: null, fileName: "見積書.xlsx" })}
      />,
    );
    expect(html).toContain("見積書.xlsx");
  });

  it("物件の添付は、その物件ページへ別タブで飛べる", () => {
    const html = renderToStaticMarkup(<AttachmentNameCell hit={hit()} />);
    expect(html).toContain(`href="/properties/${UUID}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("別タブ");
  });

  it("所有者の添付は、その所有者ページへ飛べる", () => {
    const html = renderToStaticMarkup(
      <AttachmentNameCell hit={hit({ targetType: "owner" })} />,
    );
    expect(html).toContain(`href="/admin/owners/${UUID}"`);
  });

  it("行き先の無い対象はリンクにしない（押せそうなのに 404 を作らない）", () => {
    const html = renderToStaticMarkup(
      <AttachmentNameCell hit={hit({ targetType: "comment" })} />,
    );
    expect(html).not.toContain("<a");
    expect(html).toContain("謄本(所有者事項)_2026-08-25.pdf");
  });

  it("宛先が空のときもリンクにしない", () => {
    const html = renderToStaticMarkup(
      <AttachmentNameCell hit={hit({ targetId: "" })} />,
    );
    expect(html).not.toContain("<a");
  });
});

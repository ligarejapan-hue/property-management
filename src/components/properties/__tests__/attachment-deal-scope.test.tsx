import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DealScopeBar, DealScopeSelect, UploadScopeSelect } from "../attachment-deal-scope";
import type { ScopeDeal } from "@/lib/attachments/deal-scope";

const purchase: ScopeDeal = { id: "dp", dealNo: "2026-0012", status: "settled", side: "purchase", settlementAt: "2026-05-30T01:00:00.000Z", createdAt: "2026-03-01T00:00:00.000Z" };
const sale: ScopeDeal = { id: "ds", dealNo: "2026-0031", status: "considering", side: "sale", settlementAt: null, createdAt: "2026-08-01T00:00:00.000Z" };
const deals = [sale, purchase];
const att = (o: Record<string, unknown> = {}) => ({ id: "a1", type: "general", docStage: "contract", dealId: null, dealCommon: false, createdAt: "2026-04-15T03:00:00.000Z", ...o });
const noop = () => {};

describe("取引で分ける部品", () => {
  it("絞り込みは すべて・取引ごと・共通・未区分(件数つき)", () => {
    const html = renderToStaticMarkup(
      <DealScopeBar deals={deals} items={[att(), att({ id: "a2", dealId: "ds" })]} filter="all" onFilter={noop} onConfirmEstimates={noop} saving={false} />,
    );
    for (const label of ["すべて", "売却 2026-0031", "仕入 2026-0012", "共通", "未区分"]) expect(html).toContain(label);
    expect(html).toContain("取引が決まっていない添付が1件あります");
    expect(html).toContain("推定どおりに確定");
  });
  it("推定が無ければ確定のボタンを出さない", () => {
    const html = renderToStaticMarkup(
      <DealScopeBar deals={deals} items={[att({ dealId: "ds" })]} filter="all" onFilter={noop} onConfirmEstimates={noop} saving={false} />,
    );
    expect(html).not.toContain("推定どおりに確定");
  });
  it("1件の欄: 未区分は推定を添え、確定済みは選んだ取引", () => {
    const est = renderToStaticMarkup(<DealScopeSelect att={att()} deals={deals} onChange={noop} saving={false} />);
    expect(est).toContain("推定: 仕入 2026-0012");
    expect(est).toContain("この取引で確定");
    const fixed = renderToStaticMarkup(<DealScopeSelect att={att({ dealCommon: true })} deals={deals} onChange={noop} saving={false} />);
    expect(fixed).not.toContain("推定:");
    expect(fixed).toMatch(/<option value="common" selected="">共通<\/option>/);
  });
  it("決めた取引が選択肢に無い(中止など)ときも消さずに出す", () => {
    const html = renderToStaticMarkup(<DealScopeSelect att={att({ dealId: "gone" })} deals={deals} onChange={noop} saving={false} />);
    expect(html).toContain('value="gone"');
  });
  it("入れるときの取引: 既定は「あとで決める」", () => {
    const html = renderToStaticMarkup(<UploadScopeSelect deals={deals} value="" onChange={noop} />);
    expect(html).toMatch(/<option value="" selected="">あとで決める<\/option>/);
    expect(html).toContain("仕入 2026-0012");
  });
});

describe("添付タブの配線(ソース)", () => {
  const tab = readFileSync(join(process.cwd(), "src/components/properties/attachment-tab.tsx"), "utf8").replace(/\r\n/g, "\n");
  const page = readFileSync(join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"), "utf8").replace(/\r\n/g, "\n");
  it("物件の画面が取引を渡し、分けられる取引があるときだけ出す", () => {
    expect(page).toMatch(/<AttachmentTab[\s\S]{0,300}deals=\{property\.deals\}/);
    expect(tab).toContain("const scopeEnabled = scopeDeals.length > 0;");
    expect(tab).toContain("{scopeEnabled && (");
  });
  it("入れるときの取引は通常の添付にだけ付ける(謄本には付けない)", () => {
    expect(tab).toContain('scopeEnabled && type === "general" && uploadScope !== "" ? uploadScope : null');
  });
  it("分けて保存・書類を撮ったときも選んだ取引を付ける(@codex P2)", () => {
    expect(tab).toContain('dealScope: scopeEnabled && uploadScope !== "" ? uploadScope : null,');
    expect(tab).toMatch(/handleScanSaved[\s\S]{0,600}saveScopes\(\[\{ attachmentId: result\.id, scope: uploadScope \}\]\)/);
  });
  it("通常の添付と謄本の両方の行に取引の欄", () => {
    expect(tab.match(/scopeControl=\{scopeControl\(att\)\}/g)?.length).toBe(2);
  });
});

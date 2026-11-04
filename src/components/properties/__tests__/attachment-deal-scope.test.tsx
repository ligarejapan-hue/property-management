import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DealScopeBar, DealScopeSelect, FixedUploadScopeNote, UploadScopeSelect } from "../attachment-deal-scope";
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
  it("取引の画面から入れるときは選ばせず、その取引を知らせる", () => {
    const html = renderToStaticMarkup(<FixedUploadScopeNote deals={deals} dealId="ds" />);
    expect(html).toContain("ここで入れた書類は「売却 2026-0031」の書類になります");
    expect(html).not.toContain("<select");
  });
});

describe("取引の画面の添付タブ(ソース)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(dashboard)/deals/[id]/page.tsx"), "utf8").replace(/\r\n/g, "\n");
  const panel = readFileSync(join(process.cwd(), "src/components/deals/deal-attachments-panel.tsx"), "utf8").replace(/\r\n/g, "\n");
  it("物件を開ける人だけにタブを出す", () => {
    expect(page).toContain('{ key: "attachments", label: "添付" }');
    expect(page).toContain('(propertyId !== null || t.key !== "attachments")');
    expect(page).toContain("const propertyId = data.canOpenProperty && deal.propertyId ? deal.propertyId : null;");
    expect(page).toMatch(/<DealAttachmentsPanel key=\{propertyId\} dealId=\{deal\.id\} propertyId=\{propertyId\} active=\{tab === "attachments"\} \/>/);
  });
  it("物件の添付の部品にこの取引を渡す・開くまで読まない", () => {
    expect(panel).toContain("fixedDealId={dealId}");
    expect(panel).toContain("deals={property.deals ?? null}");
    expect(panel).toContain("const requested = active || state !== null;");
    expect(panel).toContain("if (!requested) return;");
    // 読めなかったら押して読み直せる(見直しの指摘)。
    expect(panel).toContain("}, [requested, propertyId, attempt]);");
    expect(panel).toContain("もう一度読む");
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
    expect(tab).toContain('scopeEnabled && type === "general" && activeUploadScope !== "" ? activeUploadScope : null');
  });
  it("分けて保存・書類を撮ったときも選んだ取引を付ける(@codex P2)", () => {
    expect(tab).toContain('dealScope: scopeEnabled && activeUploadScope !== "" ? activeUploadScope : null,');
    // 撮った書類は saveScopes の「変更中なら何もしない」を通さずに直接送る(見直しの指摘)。
    expect(tab).toMatch(/handleScanSaved[\s\S]{0,800}updateAttachmentDealScope\(propertyId, \[\{ attachmentId: result\.id, scope: activeUploadScope \}\]\)/);
  });
  it("取引の画面から: 最初はその取引だけ・入れた書類はその取引(選ばせない)", () => {
    expect(tab).toContain('const fixedDeal = fixedDealId ? (scopeDeals.find((d) => d.id === fixedDealId) ?? null) : null;');
    expect(tab).toContain('useState(() => fixedDeal?.id ?? "all")');
    expect(tab).toContain("const activeUploadScope = fixedDeal ? fixedDeal.id : uploadScope;");
    expect(tab).toMatch(/fixedDeal \? \(\s*<FixedUploadScopeNote/);
    // 送るときは必ず activeUploadScope を通す(取引の画面で選択の値を使わない)。
    expect(tab.match(/uploadScope !== ""/g)).toBeNull();
  });
  it("通常の添付と謄本の両方の行に取引の欄", () => {
    expect(tab.match(/scopeControl=\{scopeControl\(att\)\}/g)?.length).toBe(2);
  });
});

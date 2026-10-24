import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const SECTION = "src/components/deals/business-docs-section.tsx";

describe("書類タブの決済の書類(段5a)", () => {
  it("書類タブに出せる書類を並べる(判定はサーバーの一覧表)", () => {
    expect(read("src/components/deals/deal-documents-panel.tsx")).toContain("<BusinessDocsSection dealId={dealId} active={active} refresh={tick} onIssued={reload} />");
    const src = read(SECTION);
    expect(src).toContain("dealsApi.availableDocuments(dealId)");
    expect(src).toContain("d.missing.length");
  });
  it("出す前の確認: 空欄の一覧・「入力に戻る」「空欄のまま出す」", () => {
    const src = read(SECTION);
    expect(src).toContain("入力に戻る");
    expect(src).toContain('doc.missing.length ? "空欄のまま出す" : "発行する"');
    expect(src).toContain("<ModalShell");
  });
  it("個人の発行者は非課税/課税を選ぶまで発行ボタンを押せない", () => {
    const src = read(SECTION);
    expect(src).toContain("const needsDecision = receipt && issuer?.individual === true && values.exempt == null;");
    expect(src).toMatch(/disabled=\{busy \|\| needsDecision \|\| doc\.blocking\.length > 0\}/);
    // 「読み込み直す」で出せる書類と版も読み直す
    expect(src).toContain("}, [dealId, active, tick, refresh]);");
  });
  it("発行は、確認を開いたときの取引の版で送る", () => {
    expect(read(SECTION)).toContain("dealsApi.issueDocument(dealId, doc.docType, version, options)");
  });
});
